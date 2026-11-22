import type { AccountType, Direction } from "@/db/schema";

/** Pure double-entry rules — no I/O, fully unit-testable. */

export type EntryInput = { accountId: string; direction: Direction; amountCents: bigint };

export class LedgerValidationError extends Error {
  constructor(
    public readonly code:
      | "EMPTY"
      | "NON_POSITIVE_AMOUNT"
      | "INVALID_DIRECTION"
      | "UNBALANCED"
      | "SINGLE_SIDED"
      | "UNKNOWN_ACCOUNT"
      | "CURRENCY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

/** Validates a journal before any DB connection is opened (fail fast). */
export function validateEntries(entries: EntryInput[]): { totalDebit: bigint; totalCredit: bigint } {
  if (entries.length < 2) {
    throw new LedgerValidationError("EMPTY", "A journal entry needs at least two ledger lines");
  }
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const e of entries) {
    if (typeof e.amountCents !== "bigint" || e.amountCents <= 0n) {
      throw new LedgerValidationError("NON_POSITIVE_AMOUNT", "Every ledger line amount must be > 0");
    }
    if (e.direction === "DEBIT") totalDebit += e.amountCents;
    else if (e.direction === "CREDIT") totalCredit += e.amountCents;
    else throw new LedgerValidationError("INVALID_DIRECTION", `Invalid direction: ${String(e.direction)}`);
  }
  if (totalDebit === 0n || totalCredit === 0n) {
    throw new LedgerValidationError("SINGLE_SIDED", "A journal needs both DEBIT and CREDIT lines");
  }
  if (totalDebit !== totalCredit) {
    throw new LedgerValidationError(
      "UNBALANCED",
      `Debits (${totalDebit}) must equal credits (${totalCredit})`,
    );
  }
  return { totalDebit, totalCredit };
}

/**
 * Normal-balance rule:
 *  ASSET / EXPENSE       → DEBIT increases, CREDIT decreases
 *  LIABILITY / REVENUE   → CREDIT increases, DEBIT decreases
 */
export function balanceDelta(accountType: AccountType, direction: Direction, amount: bigint): bigint {
  const debitNormal = accountType === "ASSET" || accountType === "EXPENSE";
  return (direction === "DEBIT") === debitNormal ? amount : -amount;
}

/** Net balance change per account for a journal, keyed by account id. */
export function netDeltas(
  entries: EntryInput[],
  typeOf: (accountId: string) => AccountType,
): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  for (const e of entries) {
    deltas.set(
      e.accountId,
      (deltas.get(e.accountId) ?? 0n) + balanceDelta(typeOf(e.accountId), e.direction, e.amountCents),
    );
  }
  return deltas;
}

/** Deadlock avoidance: every transaction locks accounts in the same (ascending id) order. */
export function lockOrder(entries: EntryInput[]): string[] {
  return [...new Set(entries.map((e) => e.accountId))].sort();
}

/** Accounting equation: Assets + Expenses == Liabilities + Revenue. */
export function equationCheck(balances: Array<{ accountType: AccountType; balance: bigint }>) {
  let left = 0n;
  let right = 0n;
  for (const b of balances) {
    if (b.accountType === "ASSET" || b.accountType === "EXPENSE") left += b.balance;
    else right += b.balance;
  }
  return { left, right, inBalance: left === right, difference: left - right };
}
