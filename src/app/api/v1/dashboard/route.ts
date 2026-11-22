import { listTenants } from "@/core/tenants/tenant.service";
import { getJournals, getOverview } from "@/core/dashboard/dashboard.queries";
import { requireTenantId } from "@/lib/tenant-context";
import { jsonResponse } from "@/lib/money";
import { problem } from "@/lib/http";


/**
 * GET /api/v1/dashboard                 → tenant list for the switcher
 * GET /api/v1/dashboard?tenant_id=…     → overview + latest journals (RLS-scoped)
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("tenant_id");
  if (!id) {
    const tenants = await listTenants();
    return jsonResponse({ tenants: tenants.map((t) => ({ id: t.id, name: t.name, currency: t.settings.currency })) });
  }
  const tenant = await requireTenantId(id);
  if (!tenant) return problem(404, "Unknown tenant");
  const [overview, journals] = await Promise.all([getOverview(tenant.id), getJournals(tenant.id, 10)]);
  return jsonResponse({ tenant: { id: tenant.id, name: tenant.name, settings: tenant.settings }, overview, journals });
}
