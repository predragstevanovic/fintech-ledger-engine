import { getKv, type KvStore } from "@/lib/redis";
import { log } from "@/lib/logger";

/**
 * Layer 1 of the two-layer idempotency pattern (ADR-003):
 *   SET idemp:<tenant>:<key> "PROCESSING" NX EX 86400
 * rejects concurrent duplicates in memory before they reach Postgres.
 * Layer 2 is UNIQUE(tenant_id, idempotency_key) inside ledger.service.ts.
 *
 * The cache fails OPEN: if Redis is unreachable we fall through to the database,
 * which remains the source of truth.
 */

export const IDEMPOTENCY_TTL_SECONDS = 86_400;
const PROCESSING = "PROCESSING";

export type AcquireResult =
  | { state: "ACQUIRED" }
  | { state: "IN_FLIGHT" }
  | { state: "COMPLETED"; journalEntryId: string }
  | { state: "BYPASSED" };

export const idempotencyKey = (tenantId: string, key: string) => `idemp:${tenantId}:${key}`;

export class IdempotencyService {
  constructor(private kv: KvStore = getKv()) {}

  async acquire(tenantId: string, key: string): Promise<AcquireResult> {
    const k = idempotencyKey(tenantId, key);
    try {
      if (await this.kv.setNx(k, PROCESSING, IDEMPOTENCY_TTL_SECONDS)) return { state: "ACQUIRED" };
      const current = await this.kv.get(k);
      if (current && current.startsWith("DONE:")) {
        return { state: "COMPLETED", journalEntryId: current.slice(5) };
      }
      return { state: "IN_FLIGHT" };
    } catch (err) {
      log.warn("idempotency.cache_unavailable", { err });
      return { state: "BYPASSED" };
    }
  }

  async complete(tenantId: string, key: string, journalEntryId: string): Promise<void> {
    try {
      await this.kv.set(idempotencyKey(tenantId, key), `DONE:${journalEntryId}`, IDEMPOTENCY_TTL_SECONDS);
    } catch (err) {
      log.warn("idempotency.complete_failed", { err });
    }
  }

  /** Releases the lock after a failure so the client may retry. */
  async release(tenantId: string, key: string): Promise<void> {
    try {
      await this.kv.del(idempotencyKey(tenantId, key));
    } catch (err) {
      log.warn("idempotency.release_failed", { err });
    }
  }
}
