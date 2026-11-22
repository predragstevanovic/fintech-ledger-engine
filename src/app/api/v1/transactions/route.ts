import { z } from "zod";
import { authenticateApiKey } from "@/core/tenants/tenant.service";
import { recordPayment } from "@/core/payments/payment.service";
import { IdempotencyService } from "@/core/idempotency/idempotency.service";
import { LedgerValidationError } from "@/core/ledger/ledger.rules";
import { SplitError } from "@/core/ledger/split.calculator";
import { jsonResponse, MoneyError, toMinorUnits } from "@/lib/money";
import { problem } from "@/lib/http";
import { log } from "@/lib/logger";


const bodySchema = z.object({
  amount_cents: z.union([z.number().int().positive(), z.string().regex(/^\d{1,18}$/)]),
  currency: z.string().length(3),
  external_ref_id: z.string().min(3).max(128).optional(),
  description: z.string().max(500).optional(),
  split: z
    .object({ merchant_bp: z.number().int(), platform_bp: z.number().int(), psp_fee_bp: z.number().int() })
    .optional(),
});

/**
 * POST /api/v1/transactions — synchronous payment posting with split.
 * Headers: Authorization: Bearer <tenant api key>, Idempotency-Key: <uuid>
 */
export async function POST(req: Request) {
  const started = performance.now();
  const tenant = await authenticateApiKey(req.headers.get("authorization"));
  if (!tenant) return problem(401, "Unauthorized", "Missing or invalid API key");

  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 128) {
    return problem(400, "Idempotency-Key required", "Send a unique Idempotency-Key header (8-128 chars)");
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return problem(422, "Invalid body", z.prettifyError(parsed.error));
  const body = parsed.data;
  if (body.currency.toUpperCase() !== tenant.settings.currency) {
    return problem(422, "Currency mismatch", `Tenant books in ${tenant.settings.currency}`);
  }

  const idem = new IdempotencyService();
  const lock = await idem.acquire(tenant.id, key);
  if (lock.state === "IN_FLIGHT") {
    return problem(409, "Request in progress", "A request with this Idempotency-Key is still being processed", {
      idempotent_layer: "redis",
    });
  }
  if (lock.state === "COMPLETED") {
    return jsonResponse(
      { status: "DUPLICATE", journal_entry_id: lock.journalEntryId, idempotent_layer: "redis" },
      { status: 200, headers: { "idempotent-replayed": "true" } },
    );
  }

  try {
    const result = await recordPayment({
      tenant,
      idempotencyKey: key,
      grossCents: toMinorUnits(body.amount_cents),
      externalRefId: body.external_ref_id ?? `pi_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      description: body.description ?? "API payment",
      split: body.split && {
        merchantBp: body.split.merchant_bp,
        platformBp: body.split.platform_bp,
        pspFeeBp: body.split.psp_fee_bp,
      },
      source: req.headers.get("x-source") === "simulator" ? "simulator" : "api",
    });
    await idem.complete(tenant.id, key, result.journalEntryId);
    const ms = Math.round(performance.now() - started);
    log.info("transaction.posted", { tenantId: tenant.id, status: result.status, ms });
    return jsonResponse(
      {
        status: result.status,
        journal_entry_id: result.journalEntryId,
        total_cents: result.totalCents,
        idempotent_layer: result.status === "DUPLICATE" ? "database" : undefined,
        processing_ms: ms,
      },
      {
        status: result.status === "POSTED" ? 201 : 200,
        headers: result.status === "DUPLICATE" ? { "idempotent-replayed": "true" } : {},
      },
    );
  } catch (err) {
    await idem.release(tenant.id, key);
    if (err instanceof LedgerValidationError || err instanceof SplitError || err instanceof MoneyError) {
      return problem(422, "Ledger validation failed", err.message);
    }
    log.error("transaction.failed", { tenantId: tenant.id, err });
    return problem(500, "Internal error", "The transaction was rolled back");
  }
}
