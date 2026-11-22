import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * All monetary values are BIGINT minor units (cents / para) — see ADR-001.
 * `mode: "bigint"` makes Drizzle hand us native JS BigInt, never `number`.
 */

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "REVENUE", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const RECON_STATUSES = [
  "MATCHED",
  "DISCREPANCY",
  "MISSING_IN_LEDGER",
  "MISSING_IN_PSP",
] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

export type TenantSettings = {
  currency: string;
  /** Default split in basis points (10000 = 100%). */
  split: { merchantBp: number; platformBp: number; pspFeeBp: number };
  industry?: string;
};

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull().unique(),
  settings: jsonb("settings").$type<TenantSettings>().notNull(),
  /** Sandbox tenants are created by integration tests and hidden from the dashboard. */
  isSandbox: boolean("is_sandbox").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    code: text("code").notNull(),
    accountType: text("account_type").$type<AccountType>().notNull(),
    currency: text("currency").notNull(),
    cachedBalance: bigint("cached_balance", { mode: "bigint" }).notNull().default(sql`0`),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_accounts_tenant_code").on(t.tenantId, t.code),
    check(
      "accounts_type_chk",
      sql`${t.accountType} in ('ASSET','LIABILITY','REVENUE','EXPENSE')`,
    ),
    check("accounts_currency_chk", sql`char_length(${t.currency}) = 3`),
  ],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text("idempotency_key").notNull(),
    externalRefId: text("external_ref_id"),
    description: text("description").notNull(),
    status: text("status").$type<"POSTED" | "VOIDED">().notNull().default("POSTED"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_journal_tenant_idempotency").on(t.tenantId, t.idempotencyKey),
    index("idx_journal_external_ref").on(t.tenantId, t.externalRefId),
    index("idx_journal_tenant_created").on(t.tenantId, t.createdAt.desc()),
    check("journal_status_chk", sql`${t.status} in ('POSTED','VOIDED')`),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    direction: text("direction").$type<Direction>().notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ledger_account_id").on(t.accountId, t.createdAt.desc()),
    index("idx_ledger_journal_id").on(t.journalEntryId),
    check("ledger_amount_positive_chk", sql`${t.amount} > 0`),
    check("ledger_direction_chk", sql`${t.direction} in ('DEBIT','CREDIT')`),
  ],
);

export const reconciliationRecords = pgTable(
  "reconciliation_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    pspTransactionId: text("psp_transaction_id").notNull(),
    pspAmount: bigint("psp_amount", { mode: "bigint" }),
    ledgerAmount: bigint("ledger_amount", { mode: "bigint" }),
    status: text("status").$type<ReconStatus>().notNull(),
    notes: text("notes"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recon_tenant").on(t.tenantId, t.reconciledAt.desc()),
    check(
      "recon_status_chk",
      sql`${t.status} in ('MATCHED','DISCREPANCY','MISSING_IN_LEDGER','MISSING_IN_PSP')`,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type LedgerEntry = typeof ledgerEntries.$inferSelect;
export type ReconciliationRecord = typeof reconciliationRecords.$inferSelect;
