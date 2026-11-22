import { after } from "next/server";
import { pspEventSchema, processPspEvent } from "@/core/webhooks/psp.events";
import { SIGNATURE_HEADER, verifySignature } from "@/lib/hmac";
import { enqueue, queueEnabled } from "@/lib/qstash";
import { jsonResponse } from "@/lib/money";
import { problem } from "@/lib/http";
import { log } from "@/lib/logger";


/**
 * POST /api/v1/webhooks/psp — fast-ack ingestion (ADR-004).
 * Verifies the HMAC signature, buffers the event, returns 202. It never opens a
 * database connection on the request path.
 */
export async function POST(req: Request) {
  const started = performance.now();
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return problem(500, "Webhook secret not configured");

  const raw = await req.text();
  const sig = verifySignature(raw, req.headers.get(SIGNATURE_HEADER), secret);
  if (!sig.ok) return problem(401, "Invalid signature", sig.reason);

  let event;
  try {
    event = pspEventSchema.parse(JSON.parse(raw));
  } catch {
    return problem(400, "Malformed event payload");
  }

  if (queueEnabled()) {
    const origin = new URL(req.url).origin;
    await enqueue(`${origin}/api/v1/workers/ledger`, event, `${event.tenant_id}-${event.id}`);
  } else {
    // Fallback without Upstash: process after the response has been sent.
    after(async () => {
      try {
        const outcome = await processPspEvent(event);
        log.info("webhook.inline_processed", { eventId: event.id, ...outcome });
      } catch (err) {
        log.error("webhook.inline_failed", { eventId: event.id, err });
      }
    });
  }

  return jsonResponse(
    {
      received: true,
      event_id: event.id,
      queue: queueEnabled() ? "qstash" : "inline-after",
      ack_ms: Math.round((performance.now() - started) * 100) / 100,
    },
    { status: 202 },
  );
}
