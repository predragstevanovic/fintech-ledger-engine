import { cookies } from "next/headers";
import { listTenants } from "@/core/tenants/tenant.service";
import { isUuid } from "@/db";

export const TENANT_COOKIE = "ledger_tenant";

/** Resolves the dashboard's active tenant from the switcher cookie (falls back to the first tenant). */
export async function resolveActiveTenant() {
  // cookies() first: it marks this render as request-time before any DB access.
  const jar = await cookies();
  const all = await listTenants();
  const wanted = jar.get(TENANT_COOKIE)?.value;
  const active = all.find((t) => t.id === wanted) ?? all[0] ?? null;
  return { tenants: all, active };
}

/** For JSON APIs used by the dashboard: explicit ?tenant_id= or body tenant_id, must be a known tenant. */
export async function requireTenantId(candidate: unknown) {
  if (!isUuid(candidate)) return null;
  const all = await listTenants();
  return all.find((t) => t.id === candidate) ?? null;
}
