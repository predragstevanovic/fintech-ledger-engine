-- =====================================================================
-- Security layer: immutability triggers, double-entry guard, RLS, grants.
-- Idempotent: safe to run on every deploy (npm run db:security).
-- =====================================================================

-- 0. Application role WITHOUT BYPASSRLS.
--    Supabase's `postgres` role has BYPASSRLS, so policies would be ignored if
--    the app queried as `postgres`. withTenant() runs `SET LOCAL ROLE ledger_app`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledger_app') THEN
    CREATE ROLE ledger_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT ledger_app TO postgres;

GRANT USAGE ON SCHEMA public TO ledger_app;
GRANT SELECT ON tenants TO ledger_app;
GRANT SELECT, INSERT, UPDATE ON accounts, journal_entries, ledger_entries TO ledger_app;
GRANT SELECT, INSERT, DELETE ON reconciliation_records TO ledger_app;

-- Ledger tables are never exposed through Supabase's public Data API.
REVOKE ALL ON tenants, accounts, journal_entries, ledger_entries, reconciliation_records
  FROM anon, authenticated;

-- 1. Strict immutability of posted ledger lines.
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY VIOLATION: Ledger entries are strictly immutable. Create a reversal journal entry instead.'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_immutable_ledger ON ledger_entries;
CREATE TRIGGER enforce_immutable_ledger
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

-- 1b. Journal headers: no deletes; the only permitted update is POSTED -> VOIDED.
CREATE OR REPLACE FUNCTION prevent_journal_modification()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SECURITY VIOLATION: Journal entries cannot be deleted.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.external_ref_id IS DISTINCT FROM OLD.external_ref_id
     OR NEW.description <> OLD.description
     OR NEW.created_at <> OLD.created_at
     OR NOT (OLD.status = 'POSTED' AND NEW.status IN ('POSTED','VOIDED')) THEN
    RAISE EXCEPTION 'SECURITY VIOLATION: Journal entries are immutable (only POSTED -> VOIDED is allowed).'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_immutable_journal ON journal_entries;
CREATE TRIGGER enforce_immutable_journal
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION prevent_journal_modification();

-- 2. Database-level double-entry guard (defence in depth behind the service check):
--    at COMMIT, every journal touched must have SUM(debit) = SUM(credit).
CREATE OR REPLACE FUNCTION assert_journal_balanced()
RETURNS TRIGGER AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0)
    INTO imbalance
    FROM ledger_entries
   WHERE journal_entry_id = NEW.journal_entry_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'DOUBLE-ENTRY VIOLATION: journal % is out of balance by % minor units',
      NEW.journal_entry_id, imbalance USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_balanced_journal ON ledger_entries;
CREATE CONSTRAINT TRIGGER enforce_balanced_journal
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- 3. Row-Level Security for multi-tenancy (FORCE also binds the table owner).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_self ON tenants;
CREATE POLICY tenant_self ON tenants FOR SELECT TO ledger_app
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_accounts ON accounts;
CREATE POLICY tenant_isolation_accounts ON accounts TO ledger_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_journals ON journal_entries;
CREATE POLICY tenant_isolation_journals ON journal_entries TO ledger_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_entries ON ledger_entries;
CREATE POLICY tenant_isolation_entries ON ledger_entries TO ledger_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_recon ON reconciliation_records;
CREATE POLICY tenant_isolation_recon ON reconciliation_records TO ledger_app
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 4. Indexes for performance and idempotency (also declared in Drizzle schema).
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_tenant_idempotency ON journal_entries(tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_journal_external_ref ON journal_entries(tenant_id, external_ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_id ON ledger_entries(account_id, created_at DESC);
