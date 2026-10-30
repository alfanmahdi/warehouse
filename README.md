# Warehouse Receiving System

Web application for a warehouse to register inbound deliveries, record received quantities (partial or full),
keep stock correct automatically, and audit every stock movement.
Built **specification-first with an AI coding agent** — see [`docs/ai-workflow.md`](docs/ai-workflow.md).

* Operators create receiving documents and record what actually arrived.
* Supervisors additionally manage products and **complete / cancel** documents.
* The backend refuses to receive more than the remaining expected quantity, and a document cannot be completed until every item is fully received.

## Stack

| Layer | Technology |
|-------|-----------|
| Database | PostgreSQL 16 (plain SQL migrations) |
| Backend | Node 22, TypeScript, Express 5, `pg`, zod, JWT + bcrypt |
| Frontend | React 18, Vite, TypeScript, React Router |
| Serving | nginx (static SPA + `/api` reverse proxy) |
| Tests | Vitest + Supertest on a real PostgreSQL; Node e2e script |
| Packaging | Docker, Docker Compose |

## Documentation map

| File | Content |
|------|---------|
| [`docs/prd.md`](docs/prd.md) | Requirements, business rules `BR-xx`, user stories + acceptance criteria, assumptions, open questions |
| [`docs/technical-spec.md`](docs/technical-spec.md) | Architecture, database design, API overview, locking strategy, authorization, test strategy |
| [`docs/erd.mmd`](docs/erd.mmd) | Entity-relationship diagram (Mermaid) |
| [`docs/openapi.yaml`](docs/openapi.yaml) | Full API contract |
| [`docs/architecture.mmd`](docs/architecture.mmd) · [`data-flow.mmd`](docs/data-flow.mmd) · [`api-flow.mmd`](docs/api-flow.mmd) · [`state-diagram.mmd`](docs/state-diagram.mmd) | Diagrams |
| [`docs/ai-workflow.md`](docs/ai-workflow.md) · [`docs/agent-tasks/`](docs/agent-tasks/README.md) · [`CLAUDE.md`](CLAUDE.md) | How the AI agent was used; prompts; agent instruction file |
| [`docs/testing.md`](docs/testing.md) | Test strategy, evidence, mutation check, **known limitations** |

## Quick start (Docker, clean environment)

Requirements: Docker with Compose v2.

```bash
git clone https://github.com/alfanmahdi/warehouse.git && cd warehouse-receiving
node scripts/init-env.mjs      # any OS (or ./scripts/init-env.sh on Linux/macOS): creates .env, prints the demo logins
docker compose up --build      # db → migrate (one-shot) → api → web
```

Open **http://localhost:8080** and sign in with the `operator` or `supervisor` credentials printed by `init-env.sh`
(they are also in `.env`, which is git-ignored).

Check it is healthy and run the end-to-end script:

```bash
curl -s localhost:8080/api/health/ready        # {"status":"ok","database":"up"}
node scripts/e2e-smoke.mjs                     # 32 checks through nginx → api → db
```

Stop: `docker compose down` (keep data) or `docker compose down -v` (delete the database volume).

> Passwords in `.env` are embedded in `DATABASE_URL`, so use letters/digits only if you edit them by hand (the generated values are hex).
> `init-env.sh` never overwrites an existing `.env` (use `--force`). Seeded users are only created if missing; changing
> `SEED_*_PASSWORD` later does not change existing accounts.

## Configuration (environment variables)

All configuration is via environment variables (`.env.example` lists them; no real secret is committed).

| Variable | Service | Purpose | Default |
|----------|---------|---------|---------|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | db | Database bootstrap and connection | — (required) |
| `JWT_SECRET` | api | Token signing key, ≥ 32 chars | — (required) |
| `JWT_EXPIRES_IN_SECONDS` | api | Token lifetime | 28800 (8 h) |
| `BCRYPT_ROUNDS` | api, migrate | Password hashing cost | 10 |
| `SEED_OPERATOR_PASSWORD` / `SEED_SUPERVISOR_PASSWORD` | migrate | Creates users `operator` / `supervisor` if missing (≥ 8 chars) | — |
| `WEB_PORT` | compose | Host port of the UI | 8080 |
| `DATABASE_URL`, `PORT`, `LOG_REQUESTS` | api | Set by compose; useful for local dev | — / 3000 / true |

The API validates its configuration at start and exits with a clear message when something is wrong.

## Migrations

Plain SQL files in `backend/migrations/` (`001_init.sql`, …), applied in order by `backend/src/migrate.ts`:
one transaction per file, a PostgreSQL advisory lock (safe if two instances start at once), checksum recorded in
`schema_migrations`, and an error if an already-applied file is edited. In Docker they run as the one-shot `migrate`
service, and `api` only starts after it succeeded. Locally: `npm run migrate:dev` (see below).

## Local development (without Docker)

Needs Node ≥ 20 and a PostgreSQL.

```bash
createdb warehouse_dev && createdb warehouse_test

# backend
cd backend && npm install
export DATABASE_URL=postgres://postgres@localhost:5432/warehouse_dev
export JWT_SECRET=$(openssl rand -hex 32)
export SEED_OPERATOR_PASSWORD=change-me-op SEED_SUPERVISOR_PASSWORD=change-me-sup
npm run migrate:dev            # schema + demo users
npm run dev                    # API on :3000

# frontend (second terminal) — proxies /api to :3000
cd frontend && npm install && npm run dev      # http://localhost:5173
```

## Testing

```bash
cd backend
# any PostgreSQL whose database name contains "test" (the suite drops and recreates its schema!)
export TEST_DATABASE_URL=postgres://postgres@localhost:5432/warehouse_test
npm test                       # 226 tests: unit + API integration + concurrency + DB integrity
npm run typecheck && npm run build
cd ../frontend && npm run build        # type-check + production build
node scripts/e2e-smoke.mjs     # against a running stack (BASE_URL=… to point elsewhere)
```

Results, requirement traceability, the mutation check and **known limitations** are in [`docs/testing.md`](docs/testing.md).

## API at a glance

Base path `/api` · JSON · `Authorization: Bearer <token>` · errors `{ "error": { "code", "message", "details?" } }` — full contract in [`docs/openapi.yaml`](docs/openapi.yaml).

```bash
TOKEN=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"operator","password":"<from .env>"}' | jq -r .token)

# record a receipt (retry-safe thanks to Idempotency-Key)
curl -s -X POST localhost:8080/api/receiving-documents/1/receipts \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"lines":[{"itemId":1,"quantity":4}]}'
```

| Status | Meaning |
|--------|---------|
| 400 `VALIDATION_ERROR` | Bad input (strings/decimals/zero/negative quantities, unknown fields, …) |
| 401 / 403 | Not logged in / role not allowed |
| 404 `NOT_FOUND` | Unknown id |
| 409 `INVALID_STATE`, `DUPLICATE_SKU`, `IDEMPOTENCY_KEY_REUSED` | State or uniqueness conflicts |
| 422 `OVER_RECEIPT`, `NOT_FULLY_RECEIVED`, `ITEM_NOT_IN_DOCUMENT`, `PRODUCT_INACTIVE`… | Business-rule violations |

## Trace a receipt from click to database

1. **UI** — `frontend/src/pages/DocumentDetail.tsx → submitReceipt()`: convenience checks, one `Idempotency-Key` per payload, button disabled while in flight, `POST /api/receiving-documents/:id/receipts`.
2. **nginx** — `frontend/nginx.conf` proxies `/api/` to the `api` container.
3. **Auth** — `backend/src/http/auth.ts → authenticate()` verifies the JWT and re-reads the user (role, `is_active`) from the database.
4. **Route + validation** — `backend/src/routes/receiving.ts` parses the id, the header and the body (`receiptCreateSchema`: integers 1..1,000,000, no duplicate items, unknown fields rejected).
5. **Service** — `backend/src/services/receiving.ts → recordReceipt()`, one transaction: lock document → idempotency → status gate → lock items → validate all lines → insert receipt → per line update item, upsert `inventory`, append `inventory_transactions` → derive status → commit.
6. **Database** — `backend/migrations/001_init.sql`: `CHECK (received <= expected)`, `CHECK (on_hand >= 0)`, append-only ledger trigger are the second line of defence.
7. **Response** — `{receipt, document}` (201), or `200` + `Idempotent-Replay: true` for a replay; errors mapped in `backend/src/http/errorHandler.ts`.

## Key design decisions

| Decision | Why |
|----------|-----|
| Explicit `complete` action and an extra `FULLY_RECEIVED` status | The brief says a document must not be *completed* unless fully received → a guarded supervisor sign-off |
| Row locks (`FOR UPDATE`) + DB CHECK constraints, default isolation | Correct under concurrency without serialization retries; the DB still protects stock if code is wrong |
| Append-only ledger + `inventory` table in the same transaction | Full audit trail; `on_hand = Σ ledger` is a testable invariant |
| `Idempotency-Key` on receipts | Network retries and double-clicks cannot double-count stock |
| No ORM | The locking/transaction logic is explicit and reviewable |
| Role read from the database each request | Deactivation / role change effective immediately |

Assumptions and open questions are in [PRD §9](docs/prd.md#9-assumptions-constraints-and-unresolved-questions).

## Project structure

```
backend/   src/{routes,services,http}, migrations/, tests/, Dockerfile
frontend/  src/{pages,components,api,auth}, nginx.conf, Dockerfile
docs/      PRD, technical spec, OpenAPI, diagrams, AI workflow, testing, agent-tasks/
scripts/   init-env.sh (secret generation), e2e-smoke.mjs
docker-compose.yml   .env.example   CLAUDE.md
```

## Known limitations

See [`docs/testing.md` §7](docs/testing.md#7-known-limitations-and-unresolved-issues). The most important ones:
the Docker images were not built in the authoring environment (registry blocked) and the UI has not been exercised in a browser —
**run `docker compose up --build` and the checklist in `docs/testing.md §6` once before relying on it**;
no login rate limiting; no way to reverse a receipt (planned: supervisor "adjustment" transactions).

## What I would do with more time

1. Stock adjustments / receipt reversal with mandatory reason and supervisor approval (PRD question 2).
2. Playwright end-to-end tests and component tests for the UI; CI pipeline running unit, integration and e2e.
3. Login rate limiting, refresh tokens or an httpOnly cookie session, user management screen.
4. Units of measure, lots/expiry, locations/bins; discrepancy/damage handling (PRD question 5).
5. `pg_trgm` indexes and a load test for the NFR-4 performance target.
