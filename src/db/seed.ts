/**
 * Seed — two isolated B2B tenants with 30 days of realistic marketplace traffic.
 *
 *   npm run db:seed            (truncates ALL ledger data, then re-seeds + runs preview)
 *
 * Every transaction goes through the real ledger service (validation, split,
 * locking, triggers), so the seed itself is an end-to-end exercise of the engine.
 * TRUNCATE is used for the reset because row-level immutability triggers forbid DELETE.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { sql } from "drizzle-orm";
import { closeDb, getDb } from "./index";
import { accounts, tenants } from "./schema";
import { DEMO_TENANTS } from "@/lib/demo";
import { sha256Hex } from "@/lib/hmac";
import { ACCOUNT_CODES } from "@/core/ledger/payment.posting";
import { recordPayment, recordRefund } from "@/core/payments/payment.service";
import { clearAccountCache, clearTenantDirectoryCache } from "@/core/tenants/tenant.service";
import { runPreview } from "./preview";

// Deterministic PRNG → reproducible demo data.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261122);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const ref = (prefix: string) =>
  `${prefix}_${Array.from({ length: 24 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(rand() * 62)]).join("")}`;

const RESTAURANTS = [
  "Restoran Dva Jelena", "Pizzeria Trattoria Bella", "Burger Bar Kafana", "Sushi Koi Beograd",
  "Ćevabdžinica Željo", "Mama Shelter Kitchen", "Wok & Roll Novi Sad", "Pekara Toma", "Vegan Corner Niš",
];
const ROUTES = [
  "Split → Trogir", "Zagreb Airport → Centar", "Dubrovnik Old Town → Lapad", "Ljubljana → Bled",
  "Rijeka → Opatija", "Zadar → Nin", "Podgorica → Budva", "Kotor → Tivat Airport",
];

type Plan = { tenantIndex: number; count: number; refunds: number };
const PLANS: Plan[] = [
  { tenantIndex: 0, count: 96, refunds: 5 },
  { tenantIndex: 1, count: 78, refunds: 4 },
];

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function main() {
  const db = getDb();
  const t0 = Date.now();
  console.log("▶ Resetting ledger tables (TRUNCATE)…");
  await db.execute(sql`truncate table reconciliation_records, ledger_entries, journal_entries, accounts, tenants cascade`);
  clearAccountCache();
  clearTenantDirectoryCache();

  for (const t of DEMO_TENANTS) {
    await db.insert(tenants).values({ id: t.id, name: t.name, apiKeyHash: sha256Hex(t.apiKey), settings: t.settings });
    await db.insert(accounts).values([
      { tenantId: t.id, code: ACCOUNT_CODES.ESCROW, name: "Escrow / PSP clearing", accountType: "ASSET", currency: t.settings.currency },
      { tenantId: t.id, code: ACCOUNT_CODES.MERCHANT_PAYABLE, name: t.settings.currency === "RSD" ? "Payable to restaurants" : "Payable to drivers", accountType: "LIABILITY", currency: t.settings.currency },
      { tenantId: t.id, code: ACCOUNT_CODES.PLATFORM_REVENUE, name: "Platform commission revenue", accountType: "REVENUE", currency: t.settings.currency },
      { tenantId: t.id, code: ACCOUNT_CODES.PSP_FEES, name: "Payment processor fees", accountType: "EXPENSE", currency: t.settings.currency },
    ]);
    console.log(`✔ tenant ${t.name} (${t.settings.currency}) + 4 accounts`);
  }

  for (const plan of PLANS) {
    const t = DEMO_TENANTS[plan.tenantIndex];
    const tenant = { id: t.id, settings: t.settings };
    const isFood = t.settings.currency === "RSD";
    const now = Date.now();

    const payments = Array.from({ length: plan.count }, (_, i) => {
      // more traffic on recent days and weekends, realistic hours
      const daysAgo = Math.floor(Math.pow(rand(), 1.3) * 30);
      const at = new Date(now - daysAgo * 86_400_000);
      at.setHours(isFood ? pick([12, 13, 14, 19, 20, 21]) : between(6, 23), between(0, 59), between(0, 59));
      if (at.getTime() > now) at.setTime(now - between(60, 3600) * 1000);
      const gross = isFood ? BigInt(between(650, 6_800)) * 100n + BigInt(pick([0, 0, 50, 99])) : BigInt(between(600, 8_500));
      return {
        i,
        at,
        gross,
        externalRefId: ref("pi"),
        description: isFood ? `Order #${between(10_000, 99_999)} — ${pick(RESTAURANTS)}` : `Ride ${pick(ROUTES)}`,
      };
    });

    let posted = 0;
    await runPool(payments, 6, async (p) => {
      await recordPayment({
        tenant,
        idempotencyKey: `seed-${t.id.slice(0, 8)}-${p.i}`,
        grossCents: p.gross,
        externalRefId: p.externalRefId,
        description: p.description,
        source: "seed",
        occurredAt: p.at,
      });
      posted++;
    });

    const refundTargets = [...payments].sort(() => rand() - 0.5).slice(0, plan.refunds);
    for (const r of refundTargets) {
      await recordRefund({
        tenant,
        idempotencyKey: `seed-refund-${r.externalRefId}`,
        paymentRefId: r.externalRefId,
        reason: isFood ? "Order cancelled by restaurant" : "Driver no-show",
        source: "seed",
        occurredAt: new Date(r.at.getTime() + 45 * 60_000),
      });
    }
    console.log(`✔ ${t.name}: ${posted} payments + ${refundTargets.length} refunds posted`);
  }

  console.log(`✔ seed finished in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  await runPreview();
}

main()
  .catch((err) => {
    console.error("✘ seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
