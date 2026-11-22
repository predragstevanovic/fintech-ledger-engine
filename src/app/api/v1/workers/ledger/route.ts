import { pspEventSchema, processPspEvent } from "@/core/webhooks/psp.events";
import { verifyQueueSignature } from "@/lib/qstash";
import { jsonResponse } from "@/lib/money";
import { problem } from "@/lib/http";
import { log } from "@/lib/logger";


/**
 * POST /api/v1/workers/ledger — QStash consumer.
 * 2xx = done (including idempotent skips); 5xx = transient error → QStash retries
 * with exponential backoff and finally moves the message to the DLQ.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const ok = await verifyQueueSignature(req.headers.get("upstash-signature"), raw, req.url);
  if (!ok) return problem(401, "Invalid queue signature");

  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  const parsed = pspEventSchema.safeParse(json);
  if (!parsed.success) return problem(400, "Malformed event"); // 4xx: not retried

  try {
    const outcome = await processPspEvent(parsed.data);
    if (outcome.outcome === "IN_FLIGHT") return problem(503, "Event in flight, retry later");
    return jsonResponse(outcome, { status: 200 });
  } catch (err) {
    log.error("worker.failed", { eventId: parsed.data.id, err });
    return problem(500, "Worker failed; will be retried");
  }
}
