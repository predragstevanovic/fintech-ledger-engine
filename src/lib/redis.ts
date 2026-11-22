import { Redis } from "@upstash/redis";
import { log } from "./logger";

/**
 * Key/value store used for the fast idempotency layer.
 * Upstash Redis when configured; otherwise a per-instance in-memory store with the
 * same SET NX EX semantics (graceful fallback — the DB unique index stays authoritative).
 */
export interface KvStore {
  readonly backend: "upstash" | "memory";
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryKv implements KvStore {
  readonly backend = "memory" as const;
  private store = new Map<string, { value: string; expiresAt: number }>();

  private live(key: string) {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit;
  }
  async setNx(key: string, value: string, ttl: number) {
    if (this.live(key)) return false;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return true;
  }
  async get(key: string) {
    return this.live(key)?.value ?? null;
  }
  async set(key: string, value: string, ttl: number) {
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }
  async del(key: string) {
    this.store.delete(key);
  }
}

class UpstashKv implements KvStore {
  readonly backend = "upstash" as const;
  constructor(private redis: Redis) {}
  async setNx(key: string, value: string, ttl: number) {
    return (await this.redis.set(key, value, { nx: true, ex: ttl })) === "OK";
  }
  async get(key: string) {
    return (await this.redis.get<string>(key)) ?? null;
  }
  async set(key: string, value: string, ttl: number) {
    await this.redis.set(key, value, { ex: ttl });
  }
  async del(key: string) {
    await this.redis.del(key);
  }
}

const g = globalThis as unknown as { __kv?: KvStore };

export function getKv(): KvStore {
  if (!g.__kv) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    g.__kv = url && token ? new UpstashKv(new Redis({ url, token })) : new MemoryKv();
    if (g.__kv.backend === "memory") {
      log.info("kv.fallback", { reason: "UPSTASH_REDIS_REST_URL not set; using in-memory idempotency cache" });
    }
  }
  return g.__kv;
}

/** Test hook. */
export function setKv(kv: KvStore | undefined) {
  g.__kv = kv;
}

export function createMemoryKv(): KvStore {
  return new MemoryKv();
}
