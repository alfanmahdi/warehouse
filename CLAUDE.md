# Project instructions for AI coding agents

This is a **specification-driven** project. The documents in `docs/` are the input; code is the output.
Do not invent business behaviour. If something is not specified, stop and record it as an assumption
or open question in `docs/prd.md §9` instead of guessing in code.

## Source of truth (read in this order before changing anything)

1. `docs/prd.md` — what the system does. Business rules are `BR-xx`, acceptance criteria `AC-x.y`.
2. `docs/technical-spec.md` — how it is built (layers, locking order, error mapping, auth order of checks).
3. `docs/openapi.yaml` — the API contract. Endpoints, schemas and error codes must match it exactly.
4. `backend/migrations/001_init.sql` + `docs/erd.mmd` — schema. Never edit an applied migration; add a new one.

If code and docs disagree, the docs win — fix the code, or change the doc **first** and say so in the commit.

## Stack and layout

- `backend/` Node 22 + TypeScript + Express 5 + `pg` (no ORM) + zod. `src/routes` (HTTP only) → `src/services` (rules + SQL).
- `frontend/` React 18 + Vite + TypeScript. Served by nginx in Docker.
- PostgreSQL 16. Migrations are plain SQL in `backend/migrations`.

## Non-negotiable rules

1. **Backend enforces every business rule.** Frontend checks are convenience only.
2. All stock-changing logic lives in `services/receiving.ts → recordReceipt()` and runs in ONE transaction:
   lock document row → check idempotency → check status → lock item rows → validate every line → write.
   Lock order: document, then items (by product_id), then inventory rows (ascending product_id).
3. Never update `inventory` or `inventory_transactions` anywhere else. The ledger is append-only.
4. SQL is always parameterised. No string-concatenated SQL.
5. Quantities are integers; do NOT coerce strings to numbers (`"5"` is invalid).
6. Services throw `AppError(code, status, message, details?)`; they never touch `req`/`res`.
7. Error responses always use `{ error: { code, message, details? } }` with codes from `docs/openapi.yaml`.
8. Check order on every endpoint: authenticate (401) → role (403) → validate (400) → load (404) → rules (409/422).
9. No secrets in the repo. Config comes from environment variables (see `.env.example`).
10. Do not add features outside PRD §3.1 (no adjustments, no editing documents, no user management UI, …).

## Commands

```bash
# backend (needs a PostgreSQL; see README)
cd backend && npm run build && npm test
# frontend
cd frontend && npm run build
# whole stack
./scripts/init-env.sh && docker compose up --build
```

## Definition of done for any task

- Behaviour matches PRD rule IDs cited in the task.
- Automated tests added/updated and `npm test` is green, including `tests/integrity.test.ts`.
- `docs/openapi.yaml` updated if the contract changed; `docs/ai-workflow.md` updated with the task.
- Small, meaningful commit (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
