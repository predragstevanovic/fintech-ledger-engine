import type { TenantSettings } from "@/db/schema";
import { calculateSplit } from "./split.calculator";
import type { EntryInput } from "./ledger.rules";

/** Standard chart of accounts every tenant gets (see SYSTEM_DESIGN §4). */
export const ACCOUNT_CODES = {
  ESCROW: "1000-ESCROW",
  MERCHANT_PAYABLE: "2000-MERCHANT-PAYABLE",
  PLATFORM_REVENUE: "4000-PLATFORM-REVENUE",
  PSP_FEES: "5000-PSP-FEES",
} as const;

export type AccountIdsByCode = Record<keyof typeof ACCOUNT_CODES, string>;

export type PaymentSplit = TenantSettings["split"];

/**
 * A customer pays `grossCents` (e.g. split 82% merchant / 15% platform / 3% PSP fee).
 * The processor keeps its fee, the rest lands in escrow. The platform recognises its
 * gross commission (platform + fee share) as revenue and books the PSP fee as an
 * expense, so its net take is exactly the platform share.
 *
 *   DEBIT  1000-ESCROW            gross − fee              (asset ↑)      97%
 *   DEBIT  5000-PSP-FEES          fee                      (expense ↑)     3%
 *   CREDIT 2000-MERCHANT-PAYABLE  merchant part            (liability ↑)  82%
 *   CREDIT 4000-PLATFORM-REVENUE  platform part + fee      (revenue ↑)    18%
 *
 * Σ debit = Σ credit = gross. The three parts come from one Largest-Remainder split,
 * so they sum to gross exactly.
 */
export function buildPaymentEntries(
  grossCents: bigint,
  split: PaymentSplit,
  ids: AccountIdsByCode,
): { entries: EntryInput[]; parts: { merchant: bigint; platform: bigint; pspFee: bigint } } {
  const [merchant, platform, pspFee] = calculateSplit(grossCents, [
    { accountId: ids.MERCHANT_PAYABLE, basisPoints: split.merchantBp },
    { accountId: ids.PLATFORM_REVENUE, basisPoints: split.platformBp },
    { accountId: ids.PSP_FEES, basisPoints: split.pspFeeBp },
  ]).map((p) => p.amountCents);

  const entries: EntryInput[] = [
    { accountId: ids.ESCROW, direction: "DEBIT", amountCents: grossCents - pspFee },
    { accountId: ids.PSP_FEES, direction: "DEBIT", amountCents: pspFee },
    { accountId: ids.MERCHANT_PAYABLE, direction: "CREDIT", amountCents: merchant },
    { accountId: ids.PLATFORM_REVENUE, direction: "CREDIT", amountCents: platform + pspFee },
  ].filter((e) => e.amountCents > 0n) as EntryInput[];

  return { entries, parts: { merchant, platform, pspFee } };
}

/** Compensating (storno) entries: same lines, opposite directions. */
export function buildReversalEntries(original: EntryInput[]): EntryInput[] {
  return original.map((e) => ({
    accountId: e.accountId,
    direction: e.direction === "DEBIT" ? "CREDIT" : "DEBIT",
    amountCents: e.amountCents,
  }));
}
