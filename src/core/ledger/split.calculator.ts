/**
 * Split payments with exact penny allocation (Largest Remainder / Hamilton method).
 *
 * Every share gets floor(total * bp / 10000). The cents lost to flooring are then
 * handed out one by one to the shares with the largest remainders, so the parts
 * always sum to exactly `totalAmountCents` — no cent is lost or created.
 */

export const BASIS_POINTS_TOTAL = 10_000;

export type SplitInput = { accountId: string; basisPoints: number };
export type SplitResult = { accountId: string; basisPoints: number; amountCents: bigint };

export class SplitError extends Error {}

export function calculateSplit(totalAmountCents: bigint, splits: SplitInput[]): SplitResult[] {
  if (typeof totalAmountCents !== "bigint") throw new SplitError("totalAmountCents must be a bigint");
  if (totalAmountCents < 0n) throw new SplitError("totalAmountCents must not be negative");
  if (splits.length === 0) throw new SplitError("At least one split is required");

  let bpSum = 0;
  for (const s of splits) {
    if (!Number.isInteger(s.basisPoints) || s.basisPoints < 0) {
      throw new SplitError(`basisPoints must be a non-negative integer (got ${s.basisPoints})`);
    }
    bpSum += s.basisPoints;
  }
  if (bpSum !== BASIS_POINTS_TOTAL) {
    throw new SplitError(`basisPoints must sum to ${BASIS_POINTS_TOTAL} (got ${bpSum})`);
  }

  const denom = BigInt(BASIS_POINTS_TOTAL);
  const parts = splits.map((s, index) => {
    const product = totalAmountCents * BigInt(s.basisPoints);
    return { ...s, index, amountCents: product / denom, remainder: product % denom };
  });

  let leftover = totalAmountCents - parts.reduce((acc, p) => acc + p.amountCents, 0n);

  // Largest remainder first; ties broken by larger share, then input order (deterministic).
  const order = [...parts].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.basisPoints !== b.basisPoints) return b.basisPoints - a.basisPoints;
    return a.index - b.index;
  });
  for (let i = 0; leftover > 0n; i++, leftover--) order[i % order.length].amountCents += 1n;

  return parts.map(({ accountId, basisPoints, amountCents }) => ({ accountId, basisPoints, amountCents }));
}
