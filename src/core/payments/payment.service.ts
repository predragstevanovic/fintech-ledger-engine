import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db";
import { journalEntries, ledgerEntries, type Tenant, type TenantSettings } from "@/db/schema";
import { buildPaymentEntries, buildReversalEntries } from "@/core/ledger/payment.posting";
import { postJournalEntry, type PostJournalResult } from "@/core/ledger/ledger.service";
import { getAccountIds } from "@/core/tenants/tenant.service";
import type { EntryInput } from "@/core/ledger/ledger.rules";

/** Application service: turns business events (payment, refund) into journal entries. */

export class PaymentError extends Error {
  constructor(
    public readonly code: "PAYMENT_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export type PaymentInput = {
  tenant: Pick<Tenant, "id" | "settings">;
  idempotencyKey: string;
  grossCents: bigint;
  externalRefId: string;
  description: string;
  split?: TenantSettings["split"];
  source: "api" | "webhook" | "seed" | "simulator";
  occurredAt?: Date;
};

export async function recordPayment(input: PaymentInput): Promise<PostJournalResult> {
  const split = input.split ?? input.tenant.settings.split;
  const ids = await getAccountIds(input.tenant.id);
  const { entries, parts } = buildPaymentEntries(input.grossCents, split, ids);
  return postJournalEntry({
    tenantId: input.tenant.id,
    idempotencyKey: input.idempotencyKey,
    externalRefId: input.externalRefId,
    description: input.description,
    currency: input.tenant.settings.currency,
    entries,
    occurredAt: input.occurredAt,
    metadata: {
      kind: "payment",
      source: input.source,
      gross_cents: input.grossCents.toString(),
      split_bp: split,
      parts: {
        merchant: parts.merchant.toString(),
        platform: parts.platform.toString(),
        psp_fee: parts.pspFee.toString(),
      },
    },
  });
}

export type RefundInput = {
  tenant: Pick<Tenant, "id" | "settings">;
  idempotencyKey: string;
  paymentRefId: string;
  reason?: string;
  source: PaymentInput["source"];
  occurredAt?: Date;
};

/** Full refund = compensating journal that mirrors the original payment's lines. */
export async function recordRefund(input: RefundInput): Promise<PostJournalResult> {
  const original = await withTenant(input.tenant.id, async (tx) => {
    const journals = await tx
      .select({ id: journalEntries.id, metadata: journalEntries.metadata })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, input.tenant.id), eq(journalEntries.externalRefId, input.paymentRefId)));
    const payment = journals.find((j) => j.metadata.kind === "payment");
    if (!payment) return null;
    const lines = await tx
      .select({ accountId: ledgerEntries.accountId, direction: ledgerEntries.direction, amountCents: ledgerEntries.amount })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.journalEntryId, payment.id));
    return { payment, lines: lines as EntryInput[] };
  });

  if (!original) throw new PaymentError("PAYMENT_NOT_FOUND", `No payment found for ${input.paymentRefId}`);

  // Only full refunds are modelled, so the refund's idempotency key is derived from the
  // payment itself: UNIQUE(tenant_id, idempotency_key) then guarantees at most one refund
  // per payment, even when two *different* refund events race each other.
  return postJournalEntry({
    tenantId: input.tenant.id,
    idempotencyKey: refundKey(input.paymentRefId),
    externalRefId: input.paymentRefId,
    description: `Refund ${input.paymentRefId}${input.reason ? ` — ${input.reason}` : ""}`,
    currency: input.tenant.settings.currency,
    entries: buildReversalEntries(original.lines),
    occurredAt: input.occurredAt,
    metadata: {
      kind: "refund",
      source: input.source,
      reverses: original.payment.id,
      event_key: input.idempotencyKey,
    },
  });
}

export const refundKey = (paymentRefId: string) => `refund:${paymentRefId}`;
