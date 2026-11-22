/**
 * Integration tests against the REAL Supabase database (no mocks).
 * Each run creates an isolated *sandbox* tenant (hidden from the dashboard).
 *
 *   npm run test:integration      (requires DATABASE_URL in .env.local)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, withTenant } from "@/db";
import { accounts, journalEntries, ledgerEntries, tenants, type TenantSettings } from "@/db/schema";
import { sha256Hex } from "@/lib/hmac";
import { ACCOUNT_CODES } from "@/core/ledger/payment.posting";
import { postJournalEntry } from "@/core/ledger/ledger.service";
import { LedgerValidationError } from "@/core/ledger/ledger.rules";
import { recordPayment, recordRefund } from "@/core/payments/payment.service";
import { getAccountIds } from "@/core/tenants/tenant.service";
import { equationCheck } from "@/core/ledger/ledger.rules";

const hasDb = Boolean(process.env.DATABASE_URL);
const settings: TenantSettings = { currency: "EUR", split: { merchantBp: 8200, platformBp: 1500, pspFeeBp: 300 } };
const run = crypto.randomUUID().slice(0, 8);

async function createSandboxTenant(name: string) {
  const db = getDb();
  const [t] = await db
    .insert(tenants)
    .values({ name: `[sandbox ${run}] ${name}`, apiKeyHash: sha256Hex(`sk_sandbox_${run}_${name}_${crypto.randomUUID()}`), settings, isSandbox: true })
    .returning();
  await db.insert(accounts).values([
    { tenantId: t.id, code: ACCOUNT_CODES.ESCROW, name: "Escrow", accountType: "ASSET", currency: "EUR" },
    { tenantId: t.id, code: ACCOUNT_CODES.MERCHANT_PAYABLE, name: "Payable", accountType: "LIABILITY", currency: "EUR" },
    { tenantId: t.id, code: ACCOUNT_CODES.PLATFORM_REVENUE, name: "Revenue", accountType: "REVENUE", currency: "EUR" },
    { tenantId: t.id, code: ACCOUNT_CODES.PSP_FEES, name: "Fees", accountType: "EXPENSE", currency: "EUR" },
  ]);
  return t;
}

describe.skipIf(!hasDb)("ledger engine on live PostgreSQL", () => {
  let A: Awaited<ReturnType<typeof createSandboxTenant>>;
  let B: Awaited<ReturnType<typeof createSandboxTenant>>;

  beforeAll(async () => {
    A = await createSandboxTenant("alpha");
    B = await createSandboxTenant("beta");
  });
  afterAll(() => closeDb());

  it("50 concurrent payments + 20 concurrent duplicates → exactly 50 journals, balanced, no lost updates", async () => {
    const amounts = Array.from({ length: 50 }, (_, i) => BigInt(1_000 + i * 37));
    const calls = [
      ...amounts.map((gross, i) =>
        recordPayment({ tenant: A, idempotencyKey: `c-${i}`, grossCents: gross, externalRefId: `pi_c_${run}_${i}`, description: `c${i}`, source: "api" }),
      ),
      // 20 duplicates of the first 10 keys, fired at the same time
      ...Array.from({ length: 20 }, (_, j) =>
        recordPayment({ tenant: A, idempotencyKey: `c-${j % 10}`, grossCents: amounts[j % 10], externalRefId: `pi_c_${run}_${j % 10}`, description: "dup", source: "api" }),
      ),
    ];
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.status === "POSTED")).toHaveLength(50);
    expect(results.filter((r) => r.status === "DUPLICATE")).toHaveLength(20);

    const balances = await withTenant(A.id, (tx) => tx.select().from(accounts));
    const escrow = balances.find((b) => b.code === ACCOUNT_CODES.ESCROW)!;
    const gross = amounts.reduce((s, a) => s + a, 0n);
    const fees = balances.find((b) => b.code === ACCOUNT_CODES.PSP_FEES)!.cachedBalance;
    expect(escrow.cachedBalance + fees).toBe(gross); // no lost update under contention
    expect(escrow.version).toBe(50);
    expect(equationCheck(balances.map((b) => ({ accountType: b.accountType, balance: b.cachedBalance }))).inBalance).toBe(true);

    const [{ n }] = await withTenant(A.id, (tx) => tx.select({ n: sql<string>`count(*)::text` }).from(journalEntries));
    expect(Number(n)).toBe(50);
  });

  it("refund is a compensating entry and is idempotent across different refund events", async () => {
    const ref = `pi_refund_${run}`;
    await recordPayment({ tenant: A, idempotencyKey: `r-pay-${run}`, grossCents: 5_000n, externalRefId: ref, description: "to refund", source: "api" });
    const [r1, r2] = await Promise.all([
      recordRefund({ tenant: A, idempotencyKey: "evt_refund_1", paymentRefId: ref, source: "webhook" }),
      recordRefund({ tenant: A, idempotencyKey: "evt_refund_2", paymentRefId: ref, source: "webhook" }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual(["DUPLICATE", "POSTED"]);
    await expect(recordRefund({ tenant: A, idempotencyKey: "x", paymentRefId: "pi_does_not_exist", source: "api" })).rejects.toThrow(/No payment/);
  });

  it("RLS: tenant B sees none of tenant A's rows, and cannot write into A's accounts", async () => {
    const seen = await withTenant(B.id, (tx) =>
      tx.select({ n: sql<string>`count(*)::text` }).from(journalEntries).where(eq(journalEntries.tenantId, A.id)),
    );
    expect(seen[0].n).toBe("0");

    const aIds = await getAccountIds(A.id);
    const bIds = await getAccountIds(B.id);
    await expect(
      postJournalEntry({
        tenantId: B.id,
        idempotencyKey: `cross-${run}`,
        description: "cross-tenant attack",
        currency: "EUR",
        entries: [
          { accountId: aIds.ESCROW, direction: "DEBIT", amountCents: 100n },
          { accountId: bIds.MERCHANT_PAYABLE, direction: "CREDIT", amountCents: 100n },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError);

    // Inserting a row tagged with another tenant violates the policy's WITH CHECK.
    await expect(
      withTenant(B.id, (tx) =>
        tx.insert(journalEntries).values({ tenantId: A.id, idempotencyKey: `forge-${run}`, description: "forged" }),
      ),
    ).rejects.toThrow();
  });

  it("immutability: UPDATE and DELETE on ledger_entries are rejected by the trigger", async () => {
    const [line] = await withTenant(A.id, (tx) => tx.select().from(ledgerEntries).limit(1));
    await expect(
      withTenant(A.id, (tx) => tx.update(ledgerEntries).set({ amount: 1n }).where(eq(ledgerEntries.id, line.id))),
    ).rejects.toThrow();
    await expect(withTenant(A.id, (tx) => tx.delete(ledgerEntries).where(eq(ledgerEntries.id, line.id)))).rejects.toThrow();
    await expect(withTenant(A.id, (tx) => tx.delete(journalEntries).where(eq(journalEntries.id, line.journalEntryId)))).rejects.toThrow();
  });

  it("deferred constraint trigger rejects an unbalanced journal even if the service check is bypassed", async () => {
    const ids = await getAccountIds(A.id);
    await expect(
      withTenant(A.id, async (tx) => {
        const [j] = await tx
          .insert(journalEntries)
          .values({ tenantId: A.id, idempotencyKey: `raw-${run}`, description: "raw unbalanced" })
          .returning();
        await tx.insert(ledgerEntries).values([
          { tenantId: A.id, journalEntryId: j.id, accountId: ids.ESCROW, direction: "DEBIT", amount: 100n },
          { tenantId: A.id, journalEntryId: j.id, accountId: ids.PLATFORM_REVENUE, direction: "CREDIT", amount: 99n },
        ]);
      }),
    ).rejects.toThrow();
  });
});
