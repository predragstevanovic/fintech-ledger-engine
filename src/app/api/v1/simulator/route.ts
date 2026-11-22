import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { journalEntries } from "@/db/schema";
import { getOverview } from "@/core/dashboard/dashboard.queries";
import { requireTenantId } from "@/lib/tenant-context";
import { demoApiKeyFor } from "@/lib/demo";
import { signPayload, SIGNATURE_HEADER } from "@/lib/hmac";
import { problem } from "@/lib/http";
import { toJson } from "@/lib/money";

export const maxDuration = 60;

const PAYMENTS = 25;
const DUPLICATE_WEBHOOKS = 10;
const lastRun = new Map<string, number>();

/**
 * POST /api/v1/simulator { tenant_id } — Chaos & Concurrency Simulator.
 * Fires 25 concurrent payments (real HTTP → /api/v1/transactions) plus the SAME signed
 * webhook event delivered 10 times concurrently (→ /api/v1/webhooks/psp), and streams
 * an NDJSON log while results arrive.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { tenant_id?: string };
  const tenant = await requireTenantId(body.tenant_id);
  if (!tenant) return problem(404, "Unknown tenant");
  const apiKey = demoApiKeyFor(tenant.id);
  const secret = process.env.WEBHOOK_SECRET;
  if (!apiKey || !secret) return problem(400, "Simulator is only available for demo tenants");

  const now = Date.now();
  if (now - (lastRun.get(tenant.id) ?? 0) < 5_000) return problem(429, "Slow down", "One run per 5 seconds");
  lastRun.set(tenant.id, now);

  const origin = new URL(req.url).origin;
  const runId = crypto.randomUUID().slice(0, 8);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(toJson(obj) + "\n"));
      const t0 = performance.now();
      const big = tenant.settings.currency === "RSD";
      send({ type: "start", runId, payments: PAYMENTS, duplicateWebhooks: DUPLICATE_WEBHOOKS, origin });

      const payments = Array.from({ length: PAYMENTS }, (_, i) => async () => {
        const started = performance.now();
        const amount = big ? 50_000 + Math.floor(Math.random() * 450_000) : 600 + Math.floor(Math.random() * 6_000);
        const res = await fetch(`${origin}/api/v1/transactions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "idempotency-key": `sim-${runId}-${i}`,
            "content-type": "application/json",
            "x-source": "simulator",
          },
          body: JSON.stringify({
            amount_cents: amount,
            currency: tenant.settings.currency,
            external_ref_id: `pi_sim_${runId}_${String(i).padStart(2, "0")}`,
            description: `Simulator payment #${i + 1}`,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { status?: string; title?: string };
        send({
          type: "log",
          kind: "payment",
          i,
          http: res.status,
          result: json.status ?? json.title ?? "ERROR",
          amount,
          ms: Math.round(performance.now() - started),
        });
        return res.status;
      });

      const eventId = `evt_sim_${runId}`;
      const payload = JSON.stringify({
        id: eventId,
        type: "payment.succeeded",
        tenant_id: tenant.id,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `pi_webhook_${runId}`,
            amount: big ? 189_900 : 2_450,
            currency: tenant.settings.currency,
            description: "Webhook payment (delivered 10x by a flaky PSP)",
          },
        },
      });
      const webhooks = Array.from({ length: DUPLICATE_WEBHOOKS }, (_, i) => async () => {
        const started = performance.now();
        const res = await fetch(`${origin}/api/v1/webhooks/psp`, {
          method: "POST",
          headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signPayload(payload, secret) },
          body: payload,
        });
        send({ type: "log", kind: "webhook", i, http: res.status, result: res.status === 202 ? "ACCEPTED" : "ERROR", ms: Math.round(performance.now() - started) });
        return res.status;
      });

      try {
        const statuses = await Promise.all([...payments, ...webhooks].map((fn) => fn().catch(() => 0)));
        const paymentStatuses = statuses.slice(0, PAYMENTS);

        // Webhooks are processed asynchronously — wait for the ledger to settle.
        let webhookJournals = 0;
        for (let attempt = 0; attempt < 16; attempt++) {
          const [{ n }] = await withTenant(tenant.id, (tx) =>
            tx
              .select({ n: sql<string>`count(*)::text` })
              .from(journalEntries)
              .where(and(eq(journalEntries.tenantId, tenant.id), eq(journalEntries.idempotencyKey, eventId))),
          );
          webhookJournals = Number(n);
          if (webhookJournals > 0) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        const overview = await getOverview(tenant.id);

        send({
          type: "summary",
          totalMs: Math.round(performance.now() - t0),
          paymentsPosted: paymentStatuses.filter((s) => s === 201).length,
          paymentsFailed: paymentStatuses.filter((s) => s !== 201 && s !== 200).length,
          webhookDeliveries: DUPLICATE_WEBHOOKS,
          webhookJournals,
          duplicatesBlocked: DUPLICATE_WEBHOOKS - webhookJournals,
          ledgerInBalance: overview.equation.inBalance,
          equation: overview.equation,
        });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
