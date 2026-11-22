/**
 * BigInt money helpers. Amounts are always integer minor units (cents/para).
 * Floating point never touches a monetary value — see ADR-001.
 */

export class MoneyError extends Error {}

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", RSD: "RSD " };

/** Parses an integer minor-unit amount from a string, bigint or *safe* integer number. */
export function toMinorUnits(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError("Amount must be an integer number of minor units (no decimals)");
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d{1,18}$/.test(value.trim())) return BigInt(value.trim());
  throw new MoneyError("Amount must be an integer number of minor units");
}

/** Parses a human decimal string such as "1234.5" or "-0.07" into minor units. */
export function parseDecimal(value: string): bigint {
  const m = /^(-)?(\d{1,16})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new MoneyError(`Invalid decimal amount: ${value}`);
  const [, neg, whole, frac = ""] = m;
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
  return neg ? -cents : cents;
}

/** Formats minor units as a grouped decimal string with currency symbol, e.g. "€1,234.56". */
export function formatMoney(value: bigint | string, currency = "EUR"): string {
  const v = typeof value === "bigint" ? value : BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toLocaleString("en-US");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${SYMBOLS[currency] ?? `${currency} `}${whole}.${frac}`;
}

export function sumBigInt(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** JSON.stringify replacer that serialises BigInt as a string (ADR-001 trade-off). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

/** Response.json() equivalent that is BigInt-safe. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(toJson(body), { ...init, headers });
}
