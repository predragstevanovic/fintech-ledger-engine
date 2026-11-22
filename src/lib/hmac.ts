import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe-style webhook signatures:  header  `t=<unix>,v1=<hex hmac_sha256(secret, "<t>.<body>")>`
 */
export const SIGNATURE_HEADER = "x-psp-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function signPayload(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "MISSING" | "MALFORMED" | "EXPIRED" | "MISMATCH" };

export function verifySignature(
  body: string,
  header: string | null,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!header) return { ok: false, reason: "MISSING" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || !/^[0-9a-f]{64}$/.test(parts.v1)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (Math.abs(now - t) > toleranceSeconds) return { ok: false, reason: "EXPIRED" };
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? { ok: true }
    : { ok: false, reason: "MISMATCH" };
}

/** API keys are stored only as SHA-256 hashes. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
