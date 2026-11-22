import { describe, expect, it } from "vitest";
import { calculateSplit, SplitError } from "@/core/ledger/split.calculator";

const S = (...bps: number[]) => bps.map((basisPoints, i) => ({ accountId: `acc-${i}`, basisPoints }));
const total = (r: { amountCents: bigint }[]) => r.reduce((s, p) => s + p.amountCents, 0n);

describe("calculateSplit — Largest Remainder penny allocation", () => {
  it("splits an evenly divisible amount exactly", () => {
    const r = calculateSplit(10_000n, S(8200, 1500, 300));
    expect(r.map((p) => p.amountCents)).toEqual([8200n, 1500n, 300n]);
  });

  it("hands leftover cents to the largest remainders (100 / 3)", () => {
    const r = calculateSplit(100n, S(3333, 3333, 3334));
    expect(total(r)).toBe(100n);
    expect(r.map((p) => p.amountCents)).toEqual([33n, 33n, 34n]);
  });

  it("never loses or creates a cent: 1 cent over three parties", () => {
    const r = calculateSplit(1n, S(8200, 1500, 300));
    expect(total(r)).toBe(1n);
    expect(r[0].amountCents).toBe(1n); // 0.82 is the largest remainder
  });

  it("breaks remainder ties deterministically (larger share, then input order)", () => {
    const r = calculateSplit(1n, S(5000, 5000));
    expect(r.map((p) => p.amountCents)).toEqual([1n, 0n]);
    const r2 = calculateSplit(3n, S(2500, 2500, 2500, 2500));
    expect(r2.map((p) => p.amountCents)).toEqual([1n, 1n, 1n, 0n]);
  });

  it("handles zero amounts and 100% single splits", () => {
    expect(total(calculateSplit(0n, S(8200, 1500, 300)))).toBe(0n);
    expect(calculateSplit(12_345n, S(10_000))[0].amountCents).toBe(12_345n);
  });

  it("works beyond Number.MAX_SAFE_INTEGER (BigInt precision)", () => {
    const huge = 9_007_199_254_740_993_123n;
    const r = calculateSplit(huge, S(8200, 1500, 300));
    expect(total(r)).toBe(huge);
  });

  it("property: parts always sum to the total and stay within 1 cent of the exact share", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 2_000; n++) {
      const k = 1 + Math.floor(rnd() * 6);
      const cuts = Array.from({ length: k - 1 }, () => Math.floor(rnd() * 10_001)).sort((a, b) => a - b);
      const bps = [...cuts, 10_000].map((c, i, arr) => c - (i ? arr[i - 1] : 0));
      const amount = BigInt(Math.floor(rnd() * 10_000_000));
      const r = calculateSplit(amount, S(...bps));
      expect(total(r)).toBe(amount);
      r.forEach((p, i) => {
        const exactFloor = (amount * BigInt(bps[i])) / 10_000n;
        expect(p.amountCents - exactFloor >= 0n && p.amountCents - exactFloor <= 1n).toBe(true);
      });
    }
  });

  it.each([
    ["bps not summing to 10000", () => calculateSplit(100n, S(5000, 4000))],
    ["negative bps", () => calculateSplit(100n, S(11_000, -1000))],
    ["fractional bps", () => calculateSplit(100n, S(5000.5, 4999.5))],
    ["negative total", () => calculateSplit(-1n, S(10_000))],
    ["empty splits", () => calculateSplit(100n, [])],
    ["number instead of bigint", () => calculateSplit(100 as unknown as bigint, S(10_000))],
  ])("rejects %s", (_name, fn) => {
    expect(fn).toThrow(SplitError);
  });
});
