import { describe, expect, it } from "vitest";
import { bigintReplacer, formatMoney, jsonResponse, MoneyError, parseDecimal, sumBigInt, toJson, toMinorUnits } from "@/lib/money";
import { sha256Hex, signPayload, verifySignature } from "@/lib/hmac";
import { IdempotencyService } from "@/core/idempotency/idempotency.service";
import { createMemoryKv, type KvStore } from "@/lib/redis";

describe("money", () => {
  it("toMinorUnits accepts bigint, safe integers and digit strings only", () => {
    expect(toMinorUnits(5n)).toBe(5n);
    expect(toMinorUnits(1234)).toBe(1234n);
    expect(toMinorUnits(" 42 ")).toBe(42n);
    expect(toMinorUnits("-7")).toBe(-7n);
    for (const bad of [0.1, 1.5, Number.MAX_SAFE_INTEGER + 2, "1.00", "abc", null, {}]) {
      expect(() => toMinorUnits(bad)).toThrow(MoneyError);
    }
  });

  it("parseDecimal avoids floating point entirely", () => {
    expect(parseDecimal("0.1") + parseDecimal("0.2")).toBe(parseDecimal("0.3"));
    expect(parseDecimal("1234.56")).toBe(123_456n);
    expect(parseDecimal("-0.07")).toBe(-7n);
    expect(parseDecimal("10")).toBe(1000n);
    expect(() => parseDecimal("1.234")).toThrow(MoneyError);
  });

  it("formatMoney groups digits and keeps exact cents", () => {
    expect(formatMoney(123_456_789n, "EUR")).toBe("€1,234,567.89");
    expect(formatMoney("-5", "USD")).toBe("-$0.05");
    expect(formatMoney(100n, "RSD")).toBe("RSD 1.00");
    expect(formatMoney(100n, "CHF")).toBe("CHF 1.00");
  });

  it("serialises BigInt safely", async () => {
    expect(toJson({ a: 9_007_199_254_740_993n })).toBe('{"a":"9007199254740993"}');
    expect(bigintReplacer("k", 1)).toBe(1);
    expect(sumBigInt([1n, 2n, 3n])).toBe(6n);
    const res = jsonResponse({ x: 1n }, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toEqual({ x: "1" });
    const p = jsonResponse({}, { headers: { "content-type": "application/problem+json" } });
    expect(p.headers.get("content-type")).toBe("application/problem+json");
  });
});

describe("HMAC webhook signatures", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;

  it("verifies a valid signature", () => {
    expect(verifySignature(body, signPayload(body, secret, now), secret, 300, now)).toEqual({ ok: true });
  });
  it("rejects tampered bodies and wrong secrets", () => {
    const sig = signPayload(body, secret, now);
    expect(verifySignature(body + " ", sig, secret, 300, now)).toEqual({ ok: false, reason: "MISMATCH" });
    expect(verifySignature(body, sig, "other", 300, now)).toEqual({ ok: false, reason: "MISMATCH" });
  });
  it("rejects replayed (expired) signatures", () => {
    expect(verifySignature(body, signPayload(body, secret, now - 301), secret, 300, now)).toEqual({ ok: false, reason: "EXPIRED" });
  });
  it("rejects missing and malformed headers", () => {
    expect(verifySignature(body, null, secret)).toEqual({ ok: false, reason: "MISSING" });
    expect(verifySignature(body, "t=abc,v1=zz", secret)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifySignature(body, "garbage", secret)).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("hashes API keys with SHA-256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("IdempotencyService (cache layer)", () => {
  it("acquires once, reports IN_FLIGHT for concurrent duplicates, then COMPLETED", async () => {
    const svc = new IdempotencyService(createMemoryKv());
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.acquire("t1", "k1")));
    expect(results.filter((r) => r.state === "ACQUIRED")).toHaveLength(1);
    expect(results.filter((r) => r.state === "IN_FLIGHT")).toHaveLength(9);
    await svc.complete("t1", "k1", "journal-1");
    expect(await svc.acquire("t1", "k1")).toEqual({ state: "COMPLETED", journalEntryId: "journal-1" });
  });

  it("scopes keys per tenant", async () => {
    const svc = new IdempotencyService(createMemoryKv());
    expect((await svc.acquire("t1", "same")).state).toBe("ACQUIRED");
    expect((await svc.acquire("t2", "same")).state).toBe("ACQUIRED");
  });

  it("release lets the client retry after a failure", async () => {
    const svc = new IdempotencyService(createMemoryKv());
    await svc.acquire("t", "k");
    await svc.release("t", "k");
    expect((await svc.acquire("t", "k")).state).toBe("ACQUIRED");
  });

  it("fails open (BYPASSED) when the cache is down", async () => {
    const broken: KvStore = {
      backend: "upstash",
      setNx: async () => {
        throw new Error("ECONNRESET");
      },
      get: async () => null,
      set: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
    };
    const svc = new IdempotencyService(broken);
    expect(await svc.acquire("t", "k")).toEqual({ state: "BYPASSED" });
    await expect(svc.complete("t", "k", "j")).resolves.toBeUndefined();
    await expect(svc.release("t", "k")).resolves.toBeUndefined();
  });

  it("memory store expires keys after the TTL", async () => {
    const kv = createMemoryKv();
    await kv.set("x", "1", -1);
    expect(await kv.get("x")).toBeNull();
    expect(await kv.setNx("x", "2", 60)).toBe(true);
  });
});
