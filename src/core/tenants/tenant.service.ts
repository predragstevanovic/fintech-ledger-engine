import { asc } from "drizzle-orm";
import { getDb, isUuid, withTenant } from "@/db";
import { accounts, tenants, type Tenant } from "@/db/schema";
import { sha256Hex } from "@/lib/hmac";
import { ACCOUNT_CODES, type AccountIdsByCode } from "@/core/ledger/payment.posting";

/**
 * Tenant directory lookups. These read only the `tenants` table (routing / auth),
 * never tenant-owned financial data, which is always accessed via withTenant() + RLS.
 */

// Directory cache: tenants change rarely, and under bursts (simulator, webhook storms)
// one shared single-flight load beats N identical queries against the pooler.
const DIRECTORY_TTL_MS = 30_000;
let directory: { at: number; rows: Promise<Tenant[]> } | null = null;

function loadDirectory(force = false): Promise<Tenant[]> {
  if (force || !directory || Date.now() - directory.at > DIRECTORY_TTL_MS) {
    const rows = getDb().select().from(tenants).orderBy(asc(tenants.name));
    directory = { at: Date.now(), rows };
    rows.catch(() => (directory = null));
  }
  return directory.rows;
}

async function findTenant(pred: (t: Tenant) => boolean): Promise<Tenant | null> {
  const hit = (await loadDirectory()).find(pred);
  if (hit) return hit;
  // Miss: refresh at most every 2s (new tenant), so bad keys cannot hammer the DB.
  if (directory && Date.now() - directory.at < 2_000) return null;
  return (await loadDirectory(true)).find(pred) ?? null;
}

export async function listTenants(): Promise<Pick<Tenant, "id" | "name" | "settings">[]> {
  return (await loadDirectory()).filter((t) => !t.isSandbox);
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  if (!isUuid(id)) return null;
  return findTenant((t) => t.id === id);
}

export async function authenticateApiKey(authorization: string | null): Promise<Tenant | null> {
  const key = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!key || key.length < 16) return null;
  const hash = sha256Hex(key);
  return findTenant((t) => t.apiKeyHash === hash);
}

export function clearTenantDirectoryCache() {
  directory = null;
}

const accountCache = new Map<string, AccountIdsByCode>();

/** Resolves the standard chart-of-accounts ids for a tenant (RLS-scoped, cached per instance). */
export async function getAccountIds(tenantId: string): Promise<AccountIdsByCode> {
  const cached = accountCache.get(tenantId);
  if (cached) return cached;
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: accounts.id, code: accounts.code }).from(accounts),
  );
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const ids = {} as AccountIdsByCode;
  for (const [k, code] of Object.entries(ACCOUNT_CODES) as [keyof AccountIdsByCode, string][]) {
    const id = byCode.get(code);
    if (!id) throw new Error(`Tenant ${tenantId} is missing account ${code}`);
    ids[k] = id;
  }
  accountCache.set(tenantId, ids);
  return ids;
}

export function clearAccountCache() {
  accountCache.clear();
}
