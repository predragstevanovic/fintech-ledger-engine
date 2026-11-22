import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db";
import { accounts, journalEntries, ledgerEntries, type AccountType } from "@/db/schema";
import {
  LedgerValidationError,
  lockOrder,
  netDeltas,
  validateEntries,
  type EntryInput,
} from "./ledger.rules";

export type PostJournalInput = {
  tenantId: string;
  idempotencyKey: string;
  externalRefId?: string | null;
  description: string;
  currency: string;
  entries: EntryInput[];
  metadata?: Record<string, unknown>;
  /** Back-dating is only used by the seed script; public APIs never pass it. */
  occurredAt?: Date;
};

export type PostJournalResult =
  | { status: "POSTED"; journalEntryId: string; totalCents: bigint }
  | { status: "DUPLICATE"; journalEntryId: string; totalCents: bigint };

/**
 * ACID double-entry posting.
 *
 * 1. Rules validated in memory before any connection is opened.
 * 2. Journal header inserted with ON CONFLICT DO NOTHING on
 *    UNIQUE(tenant_id, idempotency_key) — the durable idempotency layer. A concurrent
 *    duplicate blocks on the unique index until the winner commits, then sees the conflict.
 * 3. Affected accounts locked `FOR UPDATE` in ascending id order (deadlock-free).
 * 4. Ledger lines inserted; cached balances updated atomically with a version bump.
 * 5. A deferred constraint trigger re-checks SUM(debit) = SUM(credit) at COMMIT.
 */
export async function postJournalEntry(input: PostJournalInput): Promise<PostJournalResult> {
  const { totalDebit } = validateEntries(input.entries);
  const when = input.occurredAt ?? new Date();

  return withTenant(input.tenantId, async (tx) => {
    const inserted = await tx
      .insert(journalEntries)
      .values({
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        externalRefId: input.externalRefId ?? null,
        description: input.description,
        metadata: { ...(input.metadata ?? {}), currency: input.currency, total_cents: totalDebit.toString() },
        createdAt: when,
      })
      .onConflictDoNothing({ target: [journalEntries.tenantId, journalEntries.idempotencyKey] })
      .returning({ id: journalEntries.id });

    if (inserted.length === 0) {
      const [existing] = await tx
        .select({ id: journalEntries.id, metadata: journalEntries.metadata })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.tenantId, input.tenantId),
            eq(journalEntries.idempotencyKey, input.idempotencyKey),
          ),
        );
      return {
        status: "DUPLICATE" as const,
        journalEntryId: existing.id,
        totalCents: BigInt(String(existing.metadata.total_cents ?? "0")),
      };
    }
    const journalEntryId = inserted[0].id;

    const types = await lockAccounts(tx, lockOrder(input.entries), input.currency);

    await tx.insert(ledgerEntries).values(
      input.entries.map((e) => ({
        tenantId: input.tenantId,
        journalEntryId,
        accountId: e.accountId,
        direction: e.direction,
        amount: e.amountCents,
        createdAt: when,
      })),
    );

    const deltas = netDeltas(input.entries, (id) => types.get(id)!);
    for (const accountId of [...deltas.keys()].sort()) {
      const delta = deltas.get(accountId)!;
      if (delta === 0n) continue;
      await tx
        .update(accounts)
        .set({
          cachedBalance: sql`${accounts.cachedBalance} + ${delta.toString()}::bigint`,
          version: sql`${accounts.version} + 1`,
        })
        .where(eq(accounts.id, accountId));
    }

    return { status: "POSTED" as const, journalEntryId, totalCents: totalDebit };
  });
}

/** Pessimistic lock in ascending id order; verifies the accounts exist for this tenant. */
async function lockAccounts(tx: Tx, ids: string[], currency: string): Promise<Map<string, AccountType>> {
  const rows = await tx
    .select({ id: accounts.id, accountType: accounts.accountType, currency: accounts.currency })
    .from(accounts)
    .where(inArray(accounts.id, ids))
    .orderBy(asc(accounts.id))
    .for("update");

  if (rows.length !== ids.length) {
    // RLS hides other tenants' accounts, so a foreign account id surfaces here too.
    throw new LedgerValidationError("UNKNOWN_ACCOUNT", "One or more accounts do not exist for this tenant");
  }
  for (const r of rows) {
    if (r.currency !== currency) {
      throw new LedgerValidationError(
        "CURRENCY_MISMATCH",
        `Account currency ${r.currency} does not match journal currency ${currency}`,
      );
    }
  }
  return new Map(rows.map((r) => [r.id, r.accountType]));
}
