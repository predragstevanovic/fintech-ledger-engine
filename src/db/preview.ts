/**
 * QA preview & invariant audit — prints what is in the database and proves the
 * engine's guarantees against the LIVE Supabase instance.
 *
 *   npm run db:preview
 *
 * Exit code 1 if any invariant fails, so it doubles as a post-deploy smoke test.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { sql } from "drizzle-orm";
import { closeDb, getDb, withTenant } from "./index";
import { listTenants } from "@/core/tenants/tenant.service";
import { getJournals, getOverview } from "@/core/dashboard/dashboard.queries";
import { formatMoney } from "@/lib/money";

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

type Check = { name: string; ok: boolean; detail: string };

function sparkline(values: bigint[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  const max = values.reduce((m, v) => (v > m ? v : m), 0n);
  return values.map((v) => (max === 0n ? bars[0] : bars[Number((v * 7n) / max)])).join("");
}

export async function runPreview(): Promise<boolean> {
  const db = getDb();
  const checks: Check[] = [];
  const all = await listTenants();

  console.log(C.bold("═══════════════════════ LEDGER PREVIEW ═══════════════════════"));
  for (const t of all) {
    const cur = t.settings.currency;
    const ov = await getOverview(t.id);
    console.log(`\n${C.bold(C.cyan(t.name))} ${C.dim(`(${t.id}) · ${t.settings.industry ?? ""} · ${cur}`)}`);
    console.table(
      ov.accounts.map((a) => ({
        code: a.code,
        type: a.accountType,
        balance: formatMoney(a.balance, cur),
        version: a.version,
      })),
    );
    console.log(
      `  journals ${ov.kpis.journals} · payments ${ov.kpis.payments} · refunds ${ov.kpis.refunds} · ledger lines ${ov.kpis.ledgerLines}`,
    );
    console.log(`  gross volume ${C.bold(formatMoney(ov.kpis.grossVolume, cur))}`);
    const last14 = ov.daily.slice(-14);
    console.log(`  daily volume (14d) ${C.cyan(sparkline(last14.map((d) => BigInt(d.gross))))}  ${C.dim(`${last14[0]?.day} → ${last14.at(-1)?.day}`)}`);

    checks.push({
      name: `${t.name}: Assets + Expenses = Liabilities + Revenue`,
      ok: ov.equation.inBalance,
      detail: `${formatMoney(ov.equation.left, cur)} = ${formatMoney(ov.equation.right, cur)}`,
    });
    checks.push({
      name: `${t.name}: RLS hides other tenants`,
      ok: ov.rls.visibleForeignRows === 0 && (all.length < 2 || ov.rls.foreignRowsInDatabase > 0),
      detail: `${ov.rls.foreignRowsInDatabase} foreign journals in DB, ${ov.rls.visibleForeignRows} visible`,
    });

    const { rows } = await getJournals(t.id, 3);
    console.log(C.dim("  latest journals:"));
    for (const j of rows) {
      console.log(`  ${C.dim(j.createdAt.slice(0, 16).replace("T", " "))} ${j.kind.padEnd(7)} ${j.description}`);
      for (const l of j.lines) {
        const amt = formatMoney(l.amount, cur).padStart(16);
        console.log(`      ${l.direction === "DEBIT" ? "DR" : "   CR"} ${l.accountCode.padEnd(24)} ${amt}`);
      }
    }

    // Immutability probe: must be rejected by the trigger (and rolled back).
    let immutable = false;
    try {
      await withTenant(t.id, (tx) => tx.execute(sql`update ledger_entries set amount = amount + 1 where id = (select id from ledger_entries limit 1)`));
    } catch (err) {
      immutable = String((err as { cause?: Error }).cause?.message ?? (err as Error).message).includes("immutable");
    }
    checks.push({ name: `${t.name}: ledger UPDATE blocked by trigger`, ok: immutable, detail: immutable ? "SECURITY VIOLATION raised" : "update was NOT blocked" });
  }

  // Global invariants (bypass-RLS audit queries).
  const [unbalanced] = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from (
      select journal_entry_id from ledger_entries group by journal_entry_id
      having sum(case when direction = 'DEBIT' then amount else -amount end) <> 0) x`);
  checks.push({ name: "Every journal: Σ debit = Σ credit", ok: unbalanced.n === "0", detail: `${unbalanced.n} unbalanced journals` });

  const [drift] = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from accounts a
    where a.cached_balance <> coalesce((
      select sum(case when (le.direction = 'DEBIT') = (a.account_type in ('ASSET','EXPENSE')) then le.amount else -le.amount end)
      from ledger_entries le where le.account_id = a.id), 0)`);
  checks.push({ name: "cached_balance == replay of ledger lines", ok: drift.n === "0", detail: `${drift.n} accounts drifted` });

  const [dupes] = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from (select 1 from journal_entries group by tenant_id, idempotency_key having count(*) > 1) x`);
  checks.push({ name: "No duplicate idempotency keys", ok: dupes.n === "0", detail: `${dupes.n} duplicates` });

  const [floats] = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from information_schema.columns
    where table_schema = 'public' and data_type in ('real', 'double precision', 'numeric')`);
  checks.push({ name: "No floating-point money columns", ok: floats.n === "0", detail: `${floats.n} float/numeric columns` });

  console.log(`\n${C.bold("═══════════════════════ INVARIANT AUDIT ══════════════════════")}`);
  for (const c of checks) console.log(`  ${c.ok ? C.green("✔") : C.red("✘")} ${c.name.padEnd(58)} ${C.dim(c.detail)}`);
  const passed = checks.every((c) => c.ok);
  console.log(`\n  ${passed ? C.green(C.bold(`ALL ${checks.length} CHECKS PASSED`)) : C.red(C.bold("SOME CHECKS FAILED"))}\n`);
  return passed;
}

// Standalone entry point (npm run db:preview)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/db/preview.ts")) {
  runPreview()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
