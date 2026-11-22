import { describe, expect, it } from "vitest";
import { parseStatement, reconcile, toCsv } from "@/core/reconciliation/reconciliation.matcher";

const ledger = [
  { journalEntryId: "j1", externalRefId: "pi_1", amountCents: 1000n },
  { journalEntryId: "j2", externalRefId: "pi_2", amountCents: 2500n },
  { journalEntryId: "j3", externalRefId: "pi_3", amountCents: 700n },
];

describe("reconcile (set-based outer join)", () => {
  it("classifies MATCHED, DISCREPANCY, MISSING_IN_LEDGER and MISSING_IN_PSP", () => {
    const res = reconcile(ledger, [
      { pspTransactionId: "pi_1", amountCents: 1000n },
      { pspTransactionId: "pi_2", amountCents: 2455n },
      { pspTransactionId: "pi_ghost", amountCents: 999n },
    ]);
    const by = Object.fromEntries(res.map((r) => [r.pspTransactionId, r]));
    expect(by.pi_1.status).toBe("MATCHED");
    expect(by.pi_1.delta).toBe(0n);
    expect(by.pi_2.status).toBe("DISCREPANCY");
    expect(by.pi_2.delta).toBe(-45n);
    expect(by.pi_ghost.status).toBe("MISSING_IN_LEDGER");
    expect(by.pi_ghost.journalEntryId).toBeNull();
    expect(by.pi_3.status).toBe("MISSING_IN_PSP");
    expect(by.pi_3.journalEntryId).toBe("j3");
    expect(res).toHaveLength(4);
  });

  it("flags duplicate PSP lines instead of double-matching", () => {
    const res = reconcile(ledger.slice(0, 1), [
      { pspTransactionId: "pi_1", amountCents: 1000n },
      { pspTransactionId: "pi_1", amountCents: 1000n },
    ]);
    expect(res.map((r) => r.status)).toEqual(["MATCHED", "DISCREPANCY"]);
    expect(res[1].notes).toMatch(/Duplicate/);
  });

  it("handles empty inputs", () => {
    expect(reconcile([], [])).toEqual([]);
    expect(reconcile(ledger, []).every((r) => r.status === "MISSING_IN_PSP")).toBe(true);
  });
});

describe("parseStatement", () => {
  it("parses CSV with amount_cents and round-trips toCsv", () => {
    const rows = [
      { pspTransactionId: "pi_a", amountCents: 1234n },
      { pspTransactionId: "pi_b", amountCents: 5n },
    ];
    expect(parseStatement(toCsv(rows))).toEqual(rows);
  });

  it("parses CSV with decimal amounts, CRLF and blank lines", () => {
    expect(parseStatement("id,amount\r\npi_x,12.5\r\n\r\npi_y,0.07\r\n")).toEqual([
      { pspTransactionId: "pi_x", amountCents: 1250n },
      { pspTransactionId: "pi_y", amountCents: 7n },
    ]);
  });

  it("parses JSON rows (amount_cents or decimal amount)", () => {
    expect(
      parseStatement([
        { psp_transaction_id: "pi_1", amount_cents: 100 },
        { id: "pi_2", amount: "3.10" },
      ]),
    ).toEqual([
      { pspTransactionId: "pi_1", amountCents: 100n },
      { pspTransactionId: "pi_2", amountCents: 310n },
    ]);
  });

  it("returns [] for empty CSV", () => expect(parseStatement("")).toEqual([]));

  it.each([
    ["bad header", "foo,bar\n1,2"],
    ["missing id", "psp_transaction_id,amount_cents\n,100"],
    ["float cents", "psp_transaction_id,amount_cents\npi_1,10.5"],
  ])("rejects %s", (_n, csv) => expect(() => parseStatement(csv)).toThrow());

  it("rejects JSON rows without id", () => {
    expect(() => parseStatement([{ amount_cents: 1 }])).toThrow(/missing/);
  });
});
