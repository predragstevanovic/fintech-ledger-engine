import { describe, expect, it } from "vitest";
import {
  balanceDelta,
  equationCheck,
  LedgerValidationError,
  lockOrder,
  netDeltas,
  validateEntries,
  type EntryInput,
} from "@/core/ledger/ledger.rules";
import { buildPaymentEntries, buildReversalEntries } from "@/core/ledger/payment.posting";

const ids = { ESCROW: "a-escrow", MERCHANT_PAYABLE: "b-merchant", PLATFORM_REVENUE: "c-revenue", PSP_FEES: "d-fees" };
const TYPES = { "a-escrow": "ASSET", "b-merchant": "LIABILITY", "c-revenue": "REVENUE", "d-fees": "EXPENSE" } as const;
const typeOf = (id: string) => TYPES[id as keyof typeof TYPES];

function expectCode(fn: () => unknown, code: LedgerValidationError["code"]) {
  try {
    fn();
    expect.unreachable("expected LedgerValidationError");
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerValidationError);
    expect((e as LedgerValidationError).code).toBe(code);
  }
}

describe("validateEntries", () => {
  const ok: EntryInput[] = [
    { accountId: "x", direction: "DEBIT", amountCents: 500n },
    { accountId: "y", direction: "CREDIT", amountCents: 300n },
    { accountId: "z", direction: "CREDIT", amountCents: 200n },
  ];
  it("accepts a balanced multi-line journal and returns totals", () => {
    expect(validateEntries(ok)).toEqual({ totalDebit: 500n, totalCredit: 500n });
  });
  it("rejects unbalanced journals", () => {
    expectCode(() => validateEntries([ok[0], ok[1]]), "UNBALANCED");
  });
  it("rejects fewer than two lines", () => expectCode(() => validateEntries([ok[0]]), "EMPTY"));
  it("rejects zero, negative and non-bigint amounts", () => {
    expectCode(() => validateEntries([{ ...ok[0], amountCents: 0n }, ok[1]]), "NON_POSITIVE_AMOUNT");
    expectCode(() => validateEntries([{ ...ok[0], amountCents: -5n }, ok[1]]), "NON_POSITIVE_AMOUNT");
    expectCode(() => validateEntries([{ ...ok[0], amountCents: 5 as unknown as bigint }, ok[1]]), "NON_POSITIVE_AMOUNT");
  });
  it("rejects single-sided journals", () => {
    expectCode(() => validateEntries([ok[0], { ...ok[0], accountId: "q" }]), "SINGLE_SIDED");
  });
  it("rejects unknown directions", () => {
    expectCode(() => validateEntries([ok[0], { ...ok[1], direction: "SIDEWAYS" as "DEBIT" }]), "INVALID_DIRECTION");
  });
});

describe("normal-balance rules", () => {
  it.each([
    ["ASSET", "DEBIT", 100n],
    ["ASSET", "CREDIT", -100n],
    ["EXPENSE", "DEBIT", 100n],
    ["EXPENSE", "CREDIT", -100n],
    ["LIABILITY", "CREDIT", 100n],
    ["LIABILITY", "DEBIT", -100n],
    ["REVENUE", "CREDIT", 100n],
    ["REVENUE", "DEBIT", -100n],
  ] as const)("%s %s → %s", (type, dir, expected) => {
    expect(balanceDelta(type, dir, 100n)).toBe(expected);
  });

  it("netDeltas aggregates multiple lines on the same account", () => {
    const d = netDeltas(
      [
        { accountId: "a-escrow", direction: "DEBIT", amountCents: 70n },
        { accountId: "a-escrow", direction: "CREDIT", amountCents: 20n },
        { accountId: "c-revenue", direction: "CREDIT", amountCents: 50n },
      ],
      typeOf,
    );
    expect(d.get("a-escrow")).toBe(50n);
    expect(d.get("c-revenue")).toBe(50n);
  });

  it("lockOrder is unique and ascending (deadlock avoidance)", () => {
    const order = lockOrder([
      { accountId: "d", direction: "DEBIT", amountCents: 1n },
      { accountId: "a", direction: "CREDIT", amountCents: 1n },
      { accountId: "d", direction: "CREDIT", amountCents: 1n },
      { accountId: "b", direction: "DEBIT", amountCents: 1n },
    ]);
    expect(order).toEqual(["a", "b", "d"]);
  });

  it("equationCheck detects balance and imbalance", () => {
    expect(
      equationCheck([
        { accountType: "ASSET", balance: 97n },
        { accountType: "EXPENSE", balance: 3n },
        { accountType: "LIABILITY", balance: 82n },
        { accountType: "REVENUE", balance: 18n },
      ]),
    ).toEqual({ left: 100n, right: 100n, inBalance: true, difference: 0n });
    expect(equationCheck([{ accountType: "ASSET", balance: 1n }]).inBalance).toBe(false);
  });
});

describe("payment posting model", () => {
  const split = { merchantBp: 8200, platformBp: 1500, pspFeeBp: 300 };

  it("books a payment as a balanced 4-line journal (97/3 debit, 82/18 credit)", () => {
    const { entries, parts } = buildPaymentEntries(10_000n, split, ids);
    expect(parts).toEqual({ merchant: 8200n, platform: 1500n, pspFee: 300n });
    expect(entries).toEqual([
      { accountId: ids.ESCROW, direction: "DEBIT", amountCents: 9700n },
      { accountId: ids.PSP_FEES, direction: "DEBIT", amountCents: 300n },
      { accountId: ids.MERCHANT_PAYABLE, direction: "CREDIT", amountCents: 8200n },
      { accountId: ids.PLATFORM_REVENUE, direction: "CREDIT", amountCents: 1800n },
    ]);
    expect(validateEntries(entries).totalDebit).toBe(10_000n);
  });

  it("keeps the accounting equation after posting odd amounts", () => {
    for (const gross of [1n, 7n, 99n, 12_345n, 999_999_999n]) {
      const { entries } = buildPaymentEntries(gross, split, ids);
      validateEntries(entries);
      const deltas = netDeltas(entries, typeOf);
      const eq = equationCheck([...deltas].map(([id, balance]) => ({ accountType: typeOf(id), balance })));
      expect(eq.inBalance).toBe(true);
    }
  });

  it("drops zero lines for tiny payments so every line stays > 0", () => {
    const { entries } = buildPaymentEntries(1n, split, ids);
    expect(entries.every((e) => e.amountCents > 0n)).toBe(true);
    expect(() => validateEntries(entries)).not.toThrow();
  });

  it("reversal mirrors every line and nets the accounts to zero", () => {
    const { entries } = buildPaymentEntries(4_321n, split, ids);
    const reversal = buildReversalEntries(entries);
    validateEntries(reversal);
    const net = netDeltas([...entries, ...reversal], typeOf);
    for (const v of net.values()) expect(v).toBe(0n);
  });
});
