import { Client, Receiver } from "@upstash/qstash";

/**
 * Upstash QStash: guaranteed delivery, exponential backoff retries and a DLQ.
 * When QSTASH_TOKEN is not configured the webhook route falls back to processing
 * the event in-process *after* the 202 response (Next.js `after()`), keeping the
 * same fast-ack contract without the durability of a queue.
 */
export const queueEnabled = () => Boolean(process.env.QSTASH_TOKEN);

let client: Client | undefined;
export function getQueue(): Client {
  client ??= new Client({ token: process.env.QSTASH_TOKEN! });
  return client;
}

export async function enqueue(url: string, body: unknown, dedupId: string) {
  return getQueue().publishJSON({
    url,
    body,
    retries: 5,
    deduplicationId: dedupId,
  });
}

/** Verifies the `Upstash-Signature` header on the worker route. */
export async function verifyQueueSignature(signature: string | null, body: string, url: string) {
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!signature || !current || !next) return false;
  try {
    return await new Receiver({ currentSigningKey: current, nextSigningKey: next }).verify({ signature, body, url });
  } catch {
    return false;
  }
}
