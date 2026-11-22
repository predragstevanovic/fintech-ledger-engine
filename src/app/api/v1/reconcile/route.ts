import { z } from "zod";
import { generateDemoStatement, getLatestReconciliation, runReconciliation } from "@/core/reconciliation/reconciliation.service";
import { parseStatement, toCsv } from "@/core/reconciliation/reconciliation.matcher";
import { requireTenantId } from "@/lib/tenant-context";
import { jsonResponse } from "@/lib/money";
import { problem } from "@/lib/http";
import { log } from "@/lib/logger";


const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), tenant_id: z.string() }),
  z.object({
    action: z.literal("run"),
    tenant_id: z.string(),
    /** CSV text (`psp_transaction_id,amount_cents`) or JSON rows */
    statement: z.union([z.string().max(2_000_000), z.array(z.record(z.string(), z.unknown())).max(50_000)]),
  }),
]);

/** GET /api/v1/reconcile?tenant_id=… — latest reconciliation snapshot. */
export async function GET(req: Request) {
  const tenant = await requireTenantId(new URL(req.url).searchParams.get("tenant_id"));
  if (!tenant) return problem(404, "Unknown tenant");
  return jsonResponse(await getLatestReconciliation(tenant.id));
}

/** POST /api/v1/reconcile — { action: "generate" } or { action: "run", statement }. */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return problem(422, "Invalid body", z.prettifyError(parsed.error));
  const tenant = await requireTenantId(parsed.data.tenant_id);
  if (!tenant) return problem(404, "Unknown tenant");

  if (parsed.data.action === "generate") {
    const rows = await generateDemoStatement(tenant.id);
    return jsonResponse({ rows: rows.length, csv: toCsv(rows) });
  }

  let psp;
  try {
    psp = parseStatement(parsed.data.statement);
  } catch (err) {
    return problem(422, "Invalid statement", (err as Error).message);
  }
  const started = performance.now();
  const { summary } = await runReconciliation(tenant.id, psp);
  const ms = Math.round(performance.now() - started);
  log.info("reconciliation.completed", { tenantId: tenant.id, ...summary, ms });
  return jsonResponse({ ...(await getLatestReconciliation(tenant.id)), summary, processing_ms: ms });
}
