# Technical Specification — Warehouse Receiving System

Derived from [`prd.md`](prd.md). Rule IDs (`BR-xx`, `FR-xx`, `NFR-x`) refer to that document.

Companion artifacts:

| Artifact | File |
|----------|------|
| ERD | [`erd.mmd`](erd.mmd) |
| API contract (OpenAPI 3) | [`openapi.yaml`](openapi.yaml) |
| Architecture diagram | [`architecture.mmd`](architecture.mmd) |
| Data-flow diagram | [`data-flow.mmd`](data-flow.mmd) |
| API flow (sequence) | [`api-flow.mmd`](api-flow.mmd) |
| State diagram | [`state-diagram.mmd`](state-diagram.mmd) |
| SQL DDL (source of truth for the schema) | [`../backend/migrations/001_init.sql`](../backend/migrations/001_init.sql) |

---

## 1. Technology stack and rationale

| Layer | Choice | Why |
|-------|--------|-----|
| Database | PostgreSQL 16 | Required relational DB; row locks, CHECK constraints, triggers, partial guarantees we rely on. |
| Backend | Node 22, TypeScript, Express 5, `pg` (no ORM) | Small and explicit. Raw parameterised SQL keeps the transaction and locking logic visible and reviewable. Express 5 forwards async errors to the error handler natively. |
| Validation | `zod` | One schema = runtime validation + TypeScript types. |
| Auth | `bcryptjs` + `jsonwebtoken` (HS256) | "Basic authentication" requirement; stateless, simple to reason about. |
| Frontend | React 18, Vite, TypeScript, React Router | Fast to build, widely understood. |
| Web server | nginx | Serves the SPA and reverse-proxies `/api` (same origin → no CORS). |
| Tests | Vitest + Supertest against a **real** PostgreSQL | Locking and constraint behaviour cannot be validated with mocks. |
| Packaging | Docker, Docker Compose | Reproducible deployment. |

---

## 2. System architecture

See [`architecture.mmd`](architecture.mmd).

| Component | Responsibility | Talks to |
|-----------|----------------|----------|
| **web** (nginx + React SPA) | UI; collects input; shows server errors; stores token; sends `Idempotency-Key` on receipts | api (via `/api`) |
| **api** (Express) | Authentication, authorization, validation, business rules, transactions, error mapping, health | db |
| **db** (PostgreSQL) | Persistent state; integrity constraints are the last line of defence | — |
| **migrate** (one-shot) | Applies migrations, seeds users (from env), then exits | db |

### 2.1 Backend layering (`backend/src`)

```
server.ts          process entry: config → pool → app.listen, graceful shutdown
app.ts             builds the Express app (middleware, routers, error handler) — used by server and tests
config.ts          environment parsing/validation (zod); fails fast on bad config
db.ts              pg pool, withTransaction() helper, bigint→number parser
errors.ts          AppError + error code catalogue
http/auth.ts       JWT sign/verify, authenticate + requireRole middleware
http/validate.ts   zod helpers, pagination parsing
http/errorHandler.ts  maps AppError / zod / pg errors to the error envelope
routes/*.ts        thin HTTP layer: parse → call service → shape response
services/*.ts      business logic and SQL (products, receiving, inventory, auth)
migrate.ts         migration runner (advisory-locked, transactional per file)
seed.ts            idempotent user seeding from environment variables
```

Rule: routes contain **no** business rules; services contain **no** HTTP concepts (they throw `AppError`).

### 2.2 Frontend structure (`frontend/src`)

```
api/client.ts      fetch wrapper (adds token, parses error envelope, 401 → logout)
auth/              AuthContext, ProtectedRoute, role helper
pages/             Login, Products, Documents, DocumentNew, DocumentDetail, Inventory, Transactions
components/        Layout/nav, Pagination, StatusBadge, ErrorBanner
```

---

## 3. ERD

See [`erd.mmd`](erd.mmd). Summary of relationships:

- `users 1—* products / receiving_documents / receipts / inventory_transactions` (who did it)
- `products 1—0..1 inventory` (current stock; row is created on first receipt)
- `receiving_documents 1—1..* receiving_items`; `receiving_items *—1 products`
- `receiving_documents 1—* receipts 1—1..* inventory_transactions`
- `inventory_transactions *—1 receiving_items` (traceability line → ledger)

Key constraints (all in the DB, independent of application code):

| Constraint | Enforces |
|------------|----------|
| `products.sku` UNIQUE + format CHECK (stored upper-case) | BR-01 |
| `receiving_items` UNIQUE (`document_id`, `product_id`) | BR-04 |
| `receiving_items.expected_quantity` CHECK 1..1,000,000 | BR-05 |
| `receiving_items` CHECK `0 ≤ received_quantity ≤ expected_quantity` | BR-06 — cannot over-receive even if app code is buggy |
| `inventory.quantity_on_hand` CHECK `≥ 0` | BR-14 |
| `inventory_transactions` trigger forbids UPDATE / DELETE / TRUNCATE | BR-14 / NFR-9 |
| `receipts.idempotency_key` UNIQUE | BR-13 |
| `receiving_documents` CHECKs tie `completed_*` / `cancelled_*` columns to status | consistency |

---

## 4. Database design

### 4.1 Tables

| Table | Purpose | Notable columns / types |
|-------|---------|-------------------------|
| `users` | Accounts | `username` (unique, lower-case), `password_hash` (bcrypt), `role` ∈ {OPERATOR, SUPERVISOR}, `is_active` |
| `products` | SKU master data | `sku` unique, `name`, `description`, `is_active` |
| `inventory` | Current stock per product | PK = `product_id`, `quantity_on_hand bigint` |
| `receiving_documents` | Inbound delivery header | `document_number` (sequence-generated `RCV-000001`), `status`, `supplier_name`, `reference_number`, `expected_date`, audit columns |
| `receiving_items` | Document lines | `expected_quantity`, `received_quantity` |
| `receipts` | One row per successful receiving submission | `idempotency_key` (nullable, unique), `received_by` |
| `inventory_transactions` | Append-only ledger | `quantity_change`, `balance_after`, `receipt_id`, `receiving_item_id` |

Types: surrogate integer identity keys (`GENERATED ALWAYS AS IDENTITY`); ledger id is `bigint`;
timestamps are `timestamptz` (UTC); stock totals are `bigint` (parsed to JS `number`, safe below 2⁵³).

### 4.2 Indexes

| Index | Query it serves |
|-------|-----------------|
| `products(sku)` unique, `products(lower(name))` | product search, SKU lookups |
| `receiving_documents(status)` | list filtered by status |
| `receiving_documents(created_at DESC, id DESC)` | newest-first listing |
| `receiving_items(document_id, product_id)` unique, `receiving_items(product_id)` | load document items; FK lookups |
| `receipts(document_id, id)` | receipts of a document |
| `inventory_transactions(product_id, id DESC)` | history per product |
| `inventory_transactions(id DESC)` | global newest-first history |

### 4.3 Migration strategy

- Plain, ordered SQL files in `backend/migrations/` named `NNN_description.sql`.
- Runner (`src/migrate.ts`): takes a `pg_advisory_lock` (safe if two containers start together),
  creates `schema_migrations(filename, applied_at)`, applies each unapplied file **in its own
  transaction**, records it, and releases the lock. Re-running is a no-op. A failure rolls back the file and exits non-zero (so Compose does not start the API).
- Applied migrations are immutable; schema changes ship as new files (forward-only).
- Compose runs migration as a separate one-shot service (`migrate`) that the API `depends_on` with `service_completed_successfully`.
- Seeding users is **not** a migration (it needs secrets from the environment). It runs after migrations in the same job and is idempotent (`INSERT … ON CONFLICT DO NOTHING`; it never overwrites an existing password).

---

## 5. API contract

Full contract: [`openapi.yaml`](openapi.yaml). Overview:

| Method & path | Roles | Success | Notable errors |
|---------------|-------|---------|----------------|
| `GET /api/health` | public | 200 | |
| `GET /api/health/ready` | public | 200 | 503 (DB down) |
| `POST /api/auth/login` | public | 200 | 400, 401 |
| `GET /api/auth/me` | any | 200 | 401 |
| `GET /api/products` | any | 200 | 400 |
| `GET /api/products/:id` | any | 200 | 404 |
| `POST /api/products` | SUPERVISOR | 201 | 400, 403, 409 `DUPLICATE_SKU` |
| `PATCH /api/products/:id` | SUPERVISOR | 200 | 400 (incl. `sku` present), 403, 404 |
| `GET /api/receiving-documents` | any | 200 | 400 |
| `GET /api/receiving-documents/:id` | any | 200 | 404 |
| `POST /api/receiving-documents` | any | 201 | 400, 422 `PRODUCT_NOT_FOUND`/`PRODUCT_INACTIVE` |
| `POST /api/receiving-documents/:id/receipts` | any | 201 (200 replay) | 400, 404, 409 `INVALID_STATE`/`IDEMPOTENCY_KEY_REUSED`, 422 `OVER_RECEIPT`/`ITEM_NOT_IN_DOCUMENT` |
| `POST /api/receiving-documents/:id/complete` | SUPERVISOR | 200 | 403, 404, 409, 422 `NOT_FULLY_RECEIVED` |
| `POST /api/receiving-documents/:id/cancel` | SUPERVISOR | 200 | 403, 404, 409 |
| `GET /api/inventory` | any | 200 | 400 |
| `GET /api/inventory/transactions` | any | 200 | 400 |

**Conventions**: camelCase JSON; error envelope `{error:{code,message,details?}}`; lists return `{data,total,limit,offset}`;
unknown body properties are **rejected** (`.strict()`), which also blocks attempts to send `sku` on update or `status` on create.
Quantities must be JSON integers — no coercion from strings.

**Error mapping** (`http/errorHandler.ts`): `AppError` → its status/code; `ZodError` → 400 `VALIDATION_ERROR` with `details:[{path,message}]`;
malformed JSON → 400; PostgreSQL `23505` on `products_sku_key` → 409 `DUPLICATE_SKU`; `23514` (CHECK violation) → 422 `OVER_RECEIPT`-class
fallback should the DB ever catch what app code missed; anything else → 500 `INTERNAL_ERROR` with no internals leaked.

---

## 6. Data flow

See [`data-flow.mmd`](data-flow.mmd). In words:

1. The browser sends JSON with a Bearer token to nginx, which proxies `/api/*` to the API.
2. The API pipeline: request logger → authenticate → role guard → zod validation → service.
3. Services run SQL against PostgreSQL. All multi-statement writes happen inside one transaction (`withTransaction`).
4. The ledger and `inventory` are written **only** by the receiving service, in the same transaction as the item update.
5. Reads (lists, history) are plain indexed queries; responses are mapped from snake_case rows to camelCase DTOs.

## 7. API flow — recording a receipt

Sequence: [`api-flow.mmd`](api-flow.mmd). Implementation: `backend/src/services/receiving.ts → recordReceipt()`.

1. **Validate shape** (route/zod): 1–100 lines; integer `itemId`, integer `quantity` 1..1,000,000; duplicate `itemId` in one request → 400.
2. `BEGIN`.
3. `SELECT … FROM receiving_documents WHERE id=$1 FOR UPDATE` → serialises all receipts/completion/cancellation for this document. 404 if absent.
4. If an `Idempotency-Key` was supplied and a receipt with that key exists: same document + same lines → return original (200); otherwise 409 `IDEMPOTENCY_KEY_REUSED`.
5. Status must be `OPEN` or `PARTIALLY_RECEIVED`, else 409 `INVALID_STATE` (BR-07).
6. `SELECT … FROM receiving_items WHERE document_id=$1 ORDER BY product_id FOR UPDATE` (lock every item row in a stable order).
7. For each line: item must belong to the document (else 422 `ITEM_NOT_IN_DOCUMENT`); `quantity ≤ expected − received` (else 422 `OVER_RECEIPT`) — BR-06.
8. Insert `receipts` row.
9. For each line **in ascending `product_id` order**: `UPDATE receiving_items SET received_quantity = received_quantity + $q`; upsert `inventory` (`on_hand = on_hand + $q … RETURNING`); insert `inventory_transactions` with `balance_after`.
10. Recompute: if every item has `received = expected` → `FULLY_RECEIVED`, else `PARTIALLY_RECEIVED`; update the document.
11. `COMMIT`; build and return `{receipt, document}`. Any exception → `ROLLBACK` (BR-08).

### 7.1 Concurrency and integrity design

| Threat | Mitigation |
|--------|------------|
| Two operators receive the same item at once and together exceed expected | Document row lock (step 3) serialises them; the second sees the updated `received_quantity` and gets `OVER_RECEIPT`. |
| App bug lets an over-receipt through | `CHECK (received_quantity <= expected_quantity)` aborts the transaction. |
| Double-click / network retry double-counts stock | `Idempotency-Key` (UNIQUE) + UI disables the button while in flight + new key per user-initiated submission. |
| Deadlock between two documents sharing products | Inventory rows are always touched in ascending `product_id` order. |
| Partial application after a mid-request failure | Single transaction; rollback on any error. |
| Someone edits the ledger | Trigger rejects UPDATE/DELETE/TRUNCATE. |
| Stock and ledger drift apart | Both written in one transaction; invariant `on_hand = Σ ledger` is asserted in tests (`tests/integrity.test.ts`). |

Transaction isolation is `READ COMMITTED` (default). Correctness comes from explicit row locks, not from raising the isolation level.

### 7.2 Completion and cancellation

- `complete`: `BEGIN` → lock the document → status must be `FULLY_RECEIVED` else 409 (or 422 `NOT_FULLY_RECEIVED` if the status is `OPEN`/`PARTIALLY_RECEIVED`) → **re-verify** `NOT EXISTS (item with received < expected)` (BR-10 is checked against item data, not just the cached status) → set `COMPLETED`, `completed_by/at` → `COMMIT`.
- `cancel`: lock the document → status must be `OPEN` else 409 → additionally verify no item has `received > 0` → set `CANCELLED`.

---

## 8. State transitions

See [`state-diagram.mmd`](state-diagram.mmd) and PRD §6. Implemented as an explicit transition table in `services/receiving.ts`
(`assertTransition(from, to)`), so illegal transitions are rejected centrally rather than by scattered `if`s.

| Current status | receipt | complete | cancel |
|---|---|---|---|
| `OPEN` | → `PARTIALLY_RECEIVED` / `FULLY_RECEIVED` | 422 `NOT_FULLY_RECEIVED` | → `CANCELLED` |
| `PARTIALLY_RECEIVED` | → `PARTIALLY_RECEIVED` / `FULLY_RECEIVED` | 422 `NOT_FULLY_RECEIVED` | 409 |
| `FULLY_RECEIVED` | 409 | → `COMPLETED` | 409 |
| `COMPLETED` | 409 | 409 | 409 |
| `CANCELLED` | 409 | 409 | 409 |

---

## 9. Authorization

Authentication: `Authorization: Bearer <JWT>`; payload `{sub, role, username}`, HS256, 8 h expiry, secret from `JWT_SECRET` (≥ 32 chars).
On every request the user is re-read from the DB (`is_active`, current role) so deactivation/role changes take effect immediately.

| Endpoint group | OPERATOR | SUPERVISOR |
|---|:-:|:-:|
| Health | public | public |
| Login | public | public |
| `GET` everything else | ✅ | ✅ |
| `POST /products`, `PATCH /products/:id` | ❌ 403 | ✅ |
| `POST /receiving-documents` | ✅ | ✅ |
| `POST /receiving-documents/:id/receipts` | ✅ | ✅ |
| `POST …/complete`, `POST …/cancel` | ❌ 403 | ✅ |

Order of checks: authenticate (401) → authorize role (403) → validate body (400) → load/lock resource (404) → state/business rules (409/422).
Role is checked **before** validation so an operator cannot probe validation behaviour of privileged endpoints.

---

## 10. Configuration (environment variables)

| Variable | Used by | Description |
|----------|---------|-------------|
| `DATABASE_URL` | api, migrate | PostgreSQL connection string |
| `PORT` | api | default 3000 |
| `JWT_SECRET` | api | ≥ 32 chars; required |
| `JWT_EXPIRES_IN_SECONDS` | api | default 28800 |
| `BCRYPT_ROUNDS` | api, migrate | default 10 |
| `SEED_OPERATOR_PASSWORD`, `SEED_SUPERVISOR_PASSWORD` | migrate | if set, ensure users `operator` / `supervisor` exist |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | db (+ compose) | database bootstrap |
| `WEB_PORT` | compose | host port for the UI (default 8080) |

`scripts/init-env.sh` generates a `.env` with random secrets. `.env` is git-ignored; `.env.example` documents the keys with placeholders only.

---

## 11. Testing strategy

Detailed results: [`testing.md`](testing.md).

| Level | Scope | Tooling | Must cover |
|-------|-------|---------|------------|
| **Unit** | Pure logic: validation schemas, status derivation, transition table, SKU normalisation | Vitest | Every zod schema boundary (0, −1, 2.5, "3", 1,000,001…), `assertTransition` for all 5×3 combinations |
| **Integration (API + real PostgreSQL)** | HTTP → service → SQL | Vitest + Supertest, real DB, migrations applied | Every BR and AC in the PRD: auth/roles, product rules, document creation rules, partial/full receipts, over-receipt, atomicity, idempotency, complete/cancel guards, inventory + ledger correctness, **concurrent receipts**, invariants (`on_hand = Σ ledger`, `received ≤ expected`), ledger immutability |
| **End-to-end** | Real stack via the public entry point (nginx → api → db) | `scripts/e2e-smoke.mjs` (Node, no extra deps) | Login both roles → create product → create document → partial receipt → over-receipt rejected → full receipt → complete → inventory & history verified |
| **Manual UI check** | Browser walkthrough | checklist in `testing.md` | Main workflow and error display |

Quality gates: `npm test` (backend) and `npm run build` (both) must pass before a commit; CI-ready (no external services besides PostgreSQL).
A browser-level E2E suite (Playwright) is listed as future work.
