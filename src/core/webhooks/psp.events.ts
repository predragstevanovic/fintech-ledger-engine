import { z } from "zod";
import { getTenantById } from "@/core/tenants/tenant.service";
import { recordPayment, recordRefund } from "@/core/payments/payment.service";
import { IdempotencyService } from "@/core/idempotency/idempotency.service";
import { toMinorUnits } from "@/lib/money";
import { log } from "@/lib/logger";

/** Stripe-like PSP event envelope. Amounts are integer minor units. */
export const pspEventSchema = z.object({
  id: z.string().min(6).max(128),
  type: z.enum(["payment.succeeded", "charge.refunded"]),
  tenant_id: z.uuid(),
  created: z.number().int().optional(),
  data: z.object({
    object: z.object({
      id: z.string().min(3).max(128),
      amount: z.union([z.number().int(), z.string().regex(/^\d{1,18}$/)]),
      currency: z.string().length(3),
      description: z.string().max(500).optional(),
    }),
  }),
});
export type PspEvent = z.infer<typeof pspEventSchema>;

export type ProcessOutcome =
  | { outcome: "POSTED"; journalEntryId: string }
  | { outcome: "DUPLICATE"; journalEntryId: string | null; layer: "redis" | "database" }
  | { outcome: "IN_FLIGHT" }
  | { outcome: "REJECTED"; reason: string };

/**
 * Ledger worker logic. Shared by the QStash consumer route and the inline fallback.
 * Throws only on transient failures, so the queue retries them (and DLQs after max retries).
 */
export async function processPspEvent(event: PspEvent, idem = new IdempotencyService()): Promise<ProcessOutcome> {
  const tenant = await getTenantById(event.tenant_id);
  if (!tenant) return { outcome: "REJECTED", reason: "UNKNOWN_TENANT" };
  const obj = event.data.object;
  if (obj.currency.toUpperCase() !== tenant.settings.currency) {
    return { outcome: "REJECTED", reason: "CURRENCY_MISMATCH" };
  }

  const lock = await idem.acquire(tenant.id, event.id);
  if (lock.state === "COMPLETED") return { outcome: "DUPLICATE", journalEntryId: lock.journalEntryId, layer: "redis" };
  if (lock.state === "IN_FLIGHT") return { outcome: "IN_FLIGHT" };

  try {
    const result =
      event.type === "payment.succeeded"
        ? await recordPayment({
            tenant,
            idempotencyKey: event.id,
            grossCents: toMinorUnits(obj.amount),
            externalRefId: obj.id,
            description: obj.description ?? `Payment ${obj.id}`,
            source: "webhook",
          })
        : await recordRefund({ tenant, idempotencyKey: event.id, paymentRefId: obj.id, source: "webhook" });

    await idem.complete(tenant.id, event.id, result.journalEntryId);
    log.info("psp_event.processed", { tenantId: tenant.id, eventId: event.id, type: event.type, status: result.status });
    return result.status === "POSTED"
      ? { outcome: "POSTED", journalEntryId: result.journalEntryId }
      : { outcome: "DUPLICATE", journalEntryId: result.journalEntryId, layer: "database" };
  } catch (err) {
    await idem.release(tenant.id, event.id);
    const code = (err as { code?: string }).code;
    if (code === "PAYMENT_NOT_FOUND" || (err as Error).name === "LedgerValidationError") {
      log.warn("psp_event.rejected", { tenantId: tenant.id, eventId: event.id, code });
      return { outcome: "REJECTED", reason: code ?? "INVALID" };
    }
    throw err;
  }
}
