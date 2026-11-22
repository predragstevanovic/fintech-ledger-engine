import { desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { reconciliationRecords } from "@/db/schema";
import { reconcile, type LedgerSide, type MatchResult, type PspSide } from "./reconciliation.matcher";

/** Net settled amount per payment reference (payments minus refunds). */
async function loadLedgerSide(tenantId: string): Promise<LedgerSide[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ journal_entry_id: string; external_ref_id: string; amount: string }>(sql`
      select (array_agg(id order by created_at) filter (where metadata->>'kind' = 'payment'))[1]::text as journal_entry_id,
             external_ref_id,
             sum(case when metadata->>'kind' = 'refund' then -(metadata->>'total_cents')::bigint
                      else (metadata->>'total_cents')::bigint end)::text as amount
        from journal_entries
       where external_ref_id is not null and metadata->>'kind' in ('payment', 'refund')
       group by external_ref_id
      having count(*) filter (where metadata->>'kind' = 'payment') > 0`);
    return rows
      .map((r) => ({ journalEntryId: r.journal_entry_id, externalRefId: r.external_ref_id, amountCents: BigInt(r.amount) }))
      .filter((r) => r.amountCents !== 0n); // fully refunded → nothing to settle
  });
}

/**
 * Builds a realistic PSP settlement statement for the demo with exactly two problems:
 *  1. one line is short by a hidden cross-border fee  → DISCREPANCY
 *  2. one PSP payment never reached our ledger        → MISSING_IN_LEDGER
 */
export async function generateDemoStatement(tenantId: string): Promise<PspSide[]> {
  const ledger = await loadLedgerSide(tenantId);
  const rows: PspSide[] = ledger.map((l) => ({ pspTransactionId: l.externalRefId, amountCents: l.amountCents }));
  if (rows.length > 0) {
    const victim = rows[Math.floor(Math.random() * rows.length)];
    const hiddenFee = victim.amountCents > 1000n ? 45n : 1n;
    victim.amountCents -= hiddenFee;
  }
  const ghostAmount = BigInt(1500 + Math.floor(Math.random() * 9000));
  rows.push({ pspTransactionId: `pi_lostwebhook_${crypto.randomUUID().slice(0, 8)}`, amountCents: ghostAmount });
  // shuffle so problems are not always at the end
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

export type ReconSummary = Record<MatchResult["status"], number> & { total: number };

/** Runs the matcher and replaces the tenant's latest reconciliation snapshot atomically. */
export async function runReconciliation(tenantId: string, psp: PspSide[]) {
  const ledger = await loadLedgerSide(tenantId);
  const results = reconcile(ledger, psp);
  await withTenant(tenantId, async (tx) => {
    await tx.delete(reconciliationRecords).where(eq(reconciliationRecords.tenantId, tenantId));
    if (results.length > 0) {
      await tx.insert(reconciliationRecords).values(
        results.map((r) => ({
          tenantId,
          journalEntryId: r.journalEntryId,
          pspTransactionId: r.pspTransactionId,
          pspAmount: r.pspAmount,
          ledgerAmount: r.ledgerAmount,
          status: r.status,
          notes: r.notes || null,
        })),
      );
    }
  });
  return { results, summary: summarize(results) };
}

export function summarize(results: Pick<MatchResult, "status">[]): ReconSummary {
  const s: ReconSummary = { MATCHED: 0, DISCREPANCY: 0, MISSING_IN_LEDGER: 0, MISSING_IN_PSP: 0, total: results.length };
  for (const r of results) s[r.status]++;
  return s;
}

export async function getLatestReconciliation(tenantId: string) {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(reconciliationRecords).orderBy(desc(reconciliationRecords.status)).limit(500),
  );
  const order = { DISCREPANCY: 0, MISSING_IN_LEDGER: 1, MISSING_IN_PSP: 2, MATCHED: 3 } as const;
  rows.sort((a, b) => order[a.status] - order[b.status]);
  return {
    reconciledAt: rows[0]?.reconciledAt?.toISOString() ?? null,
    summary: summarize(rows),
    rows: rows.map((r) => ({
      id: r.id,
      status: r.status,
      pspTransactionId: r.pspTransactionId,
      journalEntryId: r.journalEntryId,
      pspAmount: r.pspAmount?.toString() ?? null,
      ledgerAmount: r.ledgerAmount?.toString() ?? null,
      delta: r.pspAmount !== null && r.ledgerAmount !== null ? (r.pspAmount - r.ledgerAmount).toString() : null,
      notes: r.notes,
    })),
  };
}
