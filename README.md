# LedgerCore — Multi-Tenant FinTech Ledger & Reconciliation Engine

A production-grade **double-entry ledger** for B2B marketplaces (think Uber / Wolt / Stripe Connect):
split payments with exact penny allocation, idempotent webhook ingestion, PostgreSQL
row-level-security multi-tenancy, immutable audit trail and PSP statement reconciliation.

**Live demo:** _DEPLOYMENT_URL_

| | |
|---|---|
| **Stack** | Next.js 16 (App Router, Partial Prerendering) · TypeScript · Drizzle ORM · Supabase PostgreSQL · Vercel · Upstash (optional) |
| **Docs** | [System design](docs/SYSTEM_DESIGN.md) · [Architecture decision records](docs/ADR_RECORDS.md) |
| **Quality** | 59 unit tests (100% lines / 99% branches on core) · 5 live-DB integration tests · 10-check data audit · chaos simulator |

## What it demonstrates

- **Double-entry accounting** — every journal has ≥ 2 lines with Σ debit = Σ credit, validated in the service *and* by a deferred constraint trigger at `COMMIT`.
- **Zero floating point** — all money is `BIGINT` minor units end-to-end (`BigInt` in TypeScript).
- **Split payments** — Largest Remainder method; property-tested so no cent is ever lost or created.
- **Real RLS isolation** — Supabase's `postgres` role has `BYPASSRLS`, so every tenant transaction switches to a dedicated `ledger_app` role (`SET LOCAL ROLE`). The dashboard proves it live: *other tenants' rows in DB: N · visible: 0*.
- **Two-layer idempotency** — Redis `SET NX EX` (in-memory fallback) + `UNIQUE(tenant_id, idempotency_key)`.
- **Deadlock-free concurrency** — accounts locked `FOR UPDATE` in ascending id order; atomic balance increments with version counter.
- **Immutable ledger** — triggers reject `UPDATE`/`DELETE`; refunds are compensating (storno) entries.
- **Reconciliation engine** — outer-join matching → `MATCHED` / `DISCREPANCY` / `MISSING_IN_LEDGER` / `MISSING_IN_PSP`.

## Dashboard

| View | |
|---|---|
| **Overview** | Live accounting-equation badge, account balances, 30-day volume, revenue vs fees, RLS proof. Tenant switcher top-right. |
| **Ledger Explorer** | Expand any journal to see its DEBIT / CREDIT lines and idempotency key. |
| **Reconciliation** | Generate a realistic PSP statement with 2 planted problems, upload your own CSV, run the engine. |
| **Chaos Simulator** | Fires 25 concurrent payments + the same signed webhook 10× and streams the results. |

## API

Demo tenants (public sandbox keys; only SHA-256 hashes are stored):

| Tenant | Currency | API key |
|---|---|---|
| BalkanDelivery d.o.o. | RSD | `sk_demo_balkandelivery_4f8a2c91` |
| AdriaticRide Mobility | EUR | `sk_demo_adriaticride_9c217e3d` |

```bash
# Post a payment (split 75/22/3 for AdriaticRide); repeat it → 200 + idempotent-replayed
curl -X POST $URL/api/v1/transactions \
  -H "Authorization: Bearer sk_demo_adriaticride_9c217e3d" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"amount_cents": 2450, "currency": "EUR", "description": "Ride Split → Trogir"}'
```

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/transactions` | Synchronous payment posting with split (Bearer key + `Idempotency-Key`) |
| `POST /api/v1/webhooks/psp` | PSP events (`payment.succeeded`, `charge.refunded`), HMAC `x-psp-signature: t=…,v1=…`, returns `202` |
| `POST /api/v1/workers/ledger` | QStash consumer (signature-verified) |
| `GET/POST /api/v1/reconcile` | Latest snapshot / `generate` / `run` (CSV `psp_transaction_id,amount_cents` or JSON) |
| `GET /api/v1/dashboard` | Tenant list, or overview + latest journals for `?tenant_id=` |
| `POST /api/v1/simulator` | Chaos run (NDJSON stream) |

Errors follow RFC 7807 (`application/problem+json`).

## Run it yourself

```bash
cp .env.example .env.local        # fill in Supabase + Vercel values
npm install
npm run db:setup                  # migrate → RLS/triggers → seed + audit preview
npm run dev
```

| Script | |
|---|---|
| `npm test` / `npm run test:coverage` | Unit tests (coverage gate 85%) |
| `npm run test:integration` | Live-database tests in isolated sandbox tenants |
| `npm run db:seed` | Reset + 2 tenants, ~180 payments over 30 days, refunds, then audit |
| `npm run db:preview` | QA preview & invariant audit of the live DB (exit 1 on failure) |
| `npm run build` | Production build |

## Project structure

```
src/
  app/(dashboard)/        overview · ledger · reconciliation · simulator
  app/api/v1/             transactions · webhooks/psp · workers/ledger · reconcile · dashboard · simulator
  core/ledger/            split.calculator · ledger.rules (pure) · ledger.service (ACID) · payment.posting
  core/idempotency/       Redis NX layer (fail-open)
  core/reconciliation/    matcher (pure) · service
  db/                     schema · withTenant() · security.sql · seed · preview
  lib/                    money (BigInt) · hmac · redis · qstash · logger
tests/unit · tests/integration
docs/SYSTEM_DESIGN.md · docs/ADR_RECORDS.md
```
