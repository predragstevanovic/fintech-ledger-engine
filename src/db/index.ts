import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Non-privileged role without BYPASSRLS; see apply-security.ts and ADR-002. */
export const APP_ROLE = "ledger_app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

type Holder = { client?: postgres.Sql; db?: Db };
const g = globalThis as unknown as { __ledgerDb?: Holder };
const holder: Holder = (g.__ledgerDb ??= {});

/**
 * Lazily created Drizzle client. Supabase Supavisor on port 6543 runs in
 * transaction-pooling mode, which does not support prepared statements,
 * hence `prepare: false`.
 */
export function getDb(): Db {
  if (!holder.db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    holder.client = postgres(url, {
      prepare: false,
      // Supavisor (transaction mode) hangs when several queries are pipelined on one
      // client connection under concurrency — send one query at a time per connection.
      max_pipeline: 1,
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idle_timeout: 20,
      connect_timeout: 15,
    });
    holder.db = drizzle(holder.client, { schema });
  }
  return holder.db;
}

export async function closeDb(): Promise<void> {
  await holder.client?.end({ timeout: 5 });
  holder.client = undefined;
  holder.db = undefined;
}

/**
 * Runs `fn` inside one ACID transaction scoped to a single tenant.
 *
 * 1. `set_config('app.current_tenant_id', …, true)` is transaction-local, so it
 *    is safe behind a transaction-mode connection pooler.
 * 2. `SET LOCAL ROLE ledger_app` drops the connection's BYPASSRLS privilege
 *    (Supabase's `postgres` role has it), so the RLS policies really apply.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`set local role ${APP_ROLE}`));
    return fn(tx);
  });
}

export { schema };
