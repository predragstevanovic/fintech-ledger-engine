import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTenant } from "@/db";
import { accounts, journalEntries, ledgerEntries, type AccountType } from "@/db/schema";
import { equationCheck } from "@/core/ledger/ledger.rules";

/** Read models for the dashboard. Every tenant query runs through withTenant() → RLS. */

export type AccountView = {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  currency: string;
  balance: string;
  version: number;
};

export type DailyPoint = { day: string; gross: string; revenue: string; fees: string; count: number };

export type Overview = {
  accounts: AccountView[];
  equation: { left: string; right: string; inBalance: boolean; difference: string };
  kpis: { journals: number; payments: number; refunds: number; grossVolume: string; ledgerLines: number };
  daily: DailyPoint[];
  rls: { visibleForeignRows: number; foreignRowsInDatabase: number };
};

export async function getOverview(tenantId: string): Promise<Overview> {
  const scoped = await withTenant(tenantId, async (tx) => {
    const accts = await tx.select().from(accounts).orderBy(asc(accounts.code));

    const [k] = await tx.execute<{
      journals: string;
      payments: string;
      refunds: string;
      gross: string;
      lines: string;
      foreign_visible: string;
    }>(sql`
      select
        (select count(*) from journal_entries)::text as journals,
        (select count(*) from journal_entries where metadata->>'kind' = 'payment')::text as payments,
        (select count(*) from journal_entries where metadata->>'kind' = 'refund')::text as refunds,
        (select coalesce(sum((metadata->>'gross_cents')::bigint), 0) from journal_entries
          where metadata->>'kind' = 'payment')::text as gross,
        (select count(*) from ledger_entries)::text as lines,
        (select count(*) from journal_entries
          where tenant_id <> current_setting('app.current_tenant_id')::uuid)::text as foreign_visible`);

    const daily = await tx.execute<{ day: string; gross: string; revenue: string; fees: string; count: string }>(sql`
      with days as (
        select generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') as d
      )
      select to_char(d, 'YYYY-MM-DD') as day,
        coalesce((select sum((j.metadata->>'gross_cents')::bigint) from journal_entries j
          where j.metadata->>'kind' = 'payment' and j.created_at >= d and j.created_at < d + interval '1 day'), 0)::text as gross,
        coalesce((select sum(case when le.direction = 'CREDIT' then le.amount else -le.amount end)
          from ledger_entries le join accounts a on a.id = le.account_id
          where a.account_type = 'REVENUE' and le.created_at >= d and le.created_at < d + interval '1 day'), 0)::text as revenue,
        coalesce((select sum(case when le.direction = 'DEBIT' then le.amount else -le.amount end)
          from ledger_entries le join accounts a on a.id = le.account_id
          where a.account_type = 'EXPENSE' and le.created_at >= d and le.created_at < d + interval '1 day'), 0)::text as fees,
        (select count(*) from journal_entries j
          where j.metadata->>'kind' = 'payment' and j.created_at >= d and j.created_at < d + interval '1 day')::text as count
      from days order by d`);

    return { accts, k, daily };
  });

  // Bypass-RLS count (directory-level) to prove the rows exist but are invisible above.
  const [foreign] = await getDb().execute<{ n: string }>(
    sql`select count(*)::text as n from journal_entries where tenant_id <> ${tenantId}::uuid`,
  );

  const eq = equationCheck(scoped.accts.map((a) => ({ accountType: a.accountType, balance: a.cachedBalance })));

  return {
    accounts: scoped.accts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      accountType: a.accountType,
      currency: a.currency,
      balance: a.cachedBalance.toString(),
      version: a.version,
    })),
    equation: {
      left: eq.left.toString(),
      right: eq.right.toString(),
      inBalance: eq.inBalance,
      difference: eq.difference.toString(),
    },
    kpis: {
      journals: Number(scoped.k.journals),
      payments: Number(scoped.k.payments),
      refunds: Number(scoped.k.refunds),
      grossVolume: scoped.k.gross,
      ledgerLines: Number(scoped.k.lines),
    },
    daily: scoped.daily.map((d) => ({ ...d, count: Number(d.count) })),
    rls: { visibleForeignRows: Number(scoped.k.foreign_visible), foreignRowsInDatabase: Number(foreign.n) },
  };
}

export type JournalView = {
  id: string;
  idempotencyKey: string;
  externalRefId: string | null;
  description: string;
  status: string;
  kind: string;
  source: string;
  totalCents: string;
  createdAt: string;
  lines: { id: string; accountCode: string; accountName: string; direction: "DEBIT" | "CREDIT"; amount: string }[];
};

export async function getJournals(tenantId: string, limit = 25, offset = 0): Promise<{ rows: JournalView[]; total: number }> {
  return withTenant(tenantId, async (tx) => {
    const journals = await tx
      .select()
      .from(journalEntries)
      .orderBy(desc(journalEntries.createdAt), desc(journalEntries.id))
      .limit(limit)
      .offset(offset);
    const [{ n }] = await tx.execute<{ n: string }>(sql`select count(*)::text as n from journal_entries`);
    if (journals.length === 0) return { rows: [], total: Number(n) };

    const lines = await tx
      .select({
        id: ledgerEntries.id,
        journalEntryId: ledgerEntries.journalEntryId,
        direction: ledgerEntries.direction,
        amount: ledgerEntries.amount,
        accountCode: accounts.code,
        accountName: accounts.name,
      })
      .from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
      .where(inArray(ledgerEntries.journalEntryId, journals.map((j) => j.id)))
      .orderBy(desc(ledgerEntries.direction), asc(accounts.code));

    return {
      total: Number(n),
      rows: journals.map((j) => ({
        id: j.id,
        idempotencyKey: j.idempotencyKey,
        externalRefId: j.externalRefId,
        description: j.description,
        status: j.status,
        kind: String(j.metadata.kind ?? "manual"),
        source: String(j.metadata.source ?? "-"),
        totalCents: String(j.metadata.total_cents ?? "0"),
        createdAt: j.createdAt.toISOString(),
        lines: lines
          .filter((l) => l.journalEntryId === j.id)
          .map((l) => ({
            id: l.id,
            accountCode: l.accountCode,
            accountName: l.accountName,
            direction: l.direction,
            amount: l.amount.toString(),
          })),
      })),
    };
  });
}
