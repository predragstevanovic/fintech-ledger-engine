import type { ReconStatus } from "@/db/schema";
import { parseDecimal, toMinorUnits } from "@/lib/money";

/** Pure set-based outer-join matcher (SYSTEM_DESIGN §5). */

export type LedgerSide = { journalEntryId: string; externalRefId: string; amountCents: bigint };
export type PspSide = { pspTransactionId: string; amountCents: bigint };

export type MatchResult = {
  status: ReconStatus;
  pspTransactionId: string;
  journalEntryId: string | null;
  pspAmount: bigint | null;
  ledgerAmount: bigint | null;
  delta: bigint | null;
  notes: string;
};

export function reconcile(ledger: LedgerSide[], psp: PspSide[]): MatchResult[] {
  const ledgerByRef = new Map(ledger.map((l) => [l.externalRefId, l]));
  const seen = new Set<string>();
  const results: MatchResult[] = [];

  for (const p of psp) {
    if (seen.has(p.pspTransactionId)) {
      results.push({
        status: "DISCREPANCY",
        pspTransactionId: p.pspTransactionId,
        journalEntryId: ledgerByRef.get(p.pspTransactionId)?.journalEntryId ?? null,
        pspAmount: p.amountCents,
        ledgerAmount: null,
        delta: null,
        notes: "Duplicate line in PSP statement",
      });
      continue;
    }
    seen.add(p.pspTransactionId);
    const l = ledgerByRef.get(p.pspTransactionId);
    if (!l) {
      results.push({
        status: "MISSING_IN_LEDGER",
        pspTransactionId: p.pspTransactionId,
        journalEntryId: null,
        pspAmount: p.amountCents,
        ledgerAmount: null,
        delta: null,
        notes: "Settled by PSP but never posted — webhook likely lost",
      });
    } else if (l.amountCents === p.amountCents) {
      results.push({
        status: "MATCHED",
        pspTransactionId: p.pspTransactionId,
        journalEntryId: l.journalEntryId,
        pspAmount: p.amountCents,
        ledgerAmount: l.amountCents,
        delta: 0n,
        notes: "",
      });
    } else {
      const delta = p.amountCents - l.amountCents;
      results.push({
        status: "DISCREPANCY",
        pspTransactionId: p.pspTransactionId,
        journalEntryId: l.journalEntryId,
        pspAmount: p.amountCents,
        ledgerAmount: l.amountCents,
        delta,
        notes: `PSP amount differs by ${delta} minor units (e.g. hidden cross-border fee)`,
      });
    }
  }

  for (const l of ledger) {
    if (!seen.has(l.externalRefId)) {
      results.push({
        status: "MISSING_IN_PSP",
        pspTransactionId: l.externalRefId,
        journalEntryId: l.journalEntryId,
        pspAmount: null,
        ledgerAmount: l.amountCents,
        delta: null,
        notes: "Posted in ledger but not yet in settlement report (settlement delay)",
      });
    }
  }
  return results;
}

/**
 * Parses a PSP statement. Accepts CSV with header `psp_transaction_id,amount_cents`
 * (or `amount` in decimal) or a JSON array of `{ psp_transaction_id, amount_cents }`.
 */
export function parseStatement(input: string | unknown[]): PspSide[] {
  if (Array.isArray(input)) {
    return input.map((row, i) => {
      const r = row as Record<string, unknown>;
      const id = String(r.psp_transaction_id ?? r.id ?? "").trim();
      if (!id) throw new Error(`Row ${i + 1}: missing psp_transaction_id`);
      const amount =
        r.amount_cents !== undefined ? toMinorUnits(r.amount_cents) : parseDecimal(String(r.amount));
      return { pspTransactionId: id, amountCents: amount };
    });
  }
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim());
  const idIdx = header.findIndex((h) => h === "psp_transaction_id" || h === "id");
  const centsIdx = header.indexOf("amount_cents");
  const decIdx = header.indexOf("amount");
  if (idIdx < 0 || (centsIdx < 0 && decIdx < 0)) {
    throw new Error("CSV header must contain psp_transaction_id and amount_cents (or amount)");
  }
  return lines.slice(1).map((line, i) => {
    const cols = line.split(",").map((c) => c.trim());
    const id = cols[idIdx];
    if (!id) throw new Error(`CSV line ${i + 2}: missing psp_transaction_id`);
    const amount = centsIdx >= 0 ? toMinorUnits(cols[centsIdx]) : parseDecimal(cols[decIdx]);
    return { pspTransactionId: id, amountCents: amount };
  });
}

export function toCsv(rows: PspSide[]): string {
  return ["psp_transaction_id,amount_cents", ...rows.map((r) => `${r.pspTransactionId},${r.amountCents}`)].join("\n");
}
