# Testing and Quality Assurance

How to run everything is in the [README](../README.md#testing). This page records **what is tested, the evidence, and what is not**.

## 1. Test pyramid

| Level | Where | Count | Needs |
|-------|-------|------:|-------|
| Unit (pure logic: status model, zod schemas, helpers, config) | `backend/tests/unit.test.ts` | 79 | nothing |
| Integration (HTTP → service → real PostgreSQL) | `backend/tests/{auth,products,documents,receiving,lifecycle,concurrency,integrity}.test.ts` | 147 | PostgreSQL |
| End-to-end smoke (through the public entry point) | `scripts/e2e-smoke.mjs` | 32 checks | running stack |
| UI | manual checklist (§6) | — | browser |

Integration tests use a **real PostgreSQL** — row locks, CHECK constraints and triggers are part of what is being
verified, so mocks would prove nothing. `globalSetup` recreates the schema of the `*_test` database (it refuses to run
against a database whose name does not contain "test") and applies the real migrations.

**Result of the last run: 8 files, 226 tests, 226 passed** (~8 s).

## 2. Requirement → test traceability

| Rule / story | Proven by |
|--------------|-----------|
| BR-01 SKU unique, upper-case, immutable (AC-1.x) | `products.test.ts` (incl. 6 parallel creations → 1 winner), `unit.test.ts`, DB CHECK in `integrity.test.ts` |
| BR-03/04/05 document creation rules (AC-2.x) | `documents.test.ts` — 13 invalid-document cases each assert **nothing was stored** |
| BR-06 no over-receipt (AC-4.1, 4.2, 4.5) | `receiving.test.ts` (boundary: remaining vs remaining + 1; 10 invalid quantity shapes) |
| BR-07/12 status gate (AC-6.5) | `lifecycle.test.ts` |
| BR-08 atomic receipt (AC-4.3) | `receiving.test.ts` (bad line first / last / unknown item) + trigger-induced failure **mid-write** in `integrity.test.ts` |
| BR-09 stock + ledger updated together (AC-3.x) | `receiving.test.ts`, `lifecycle.test.ts` happy path |
| BR-10 completion guard (AC-6.x) | `lifecycle.test.ts` incl. corrupted-status case: completion is judged on item data |
| BR-11 cancellation guard (AC-7.x) | `lifecycle.test.ts` |
| BR-13 idempotency (AC-5.x) | `receiving.test.ts`, 8 parallel same-key requests in `concurrency.test.ts` |
| BR-14 invariants, append-only ledger | `integrity.test.ts` (UPDATE/DELETE/TRUNCATE rejected), `driftedProducts()` after every suite |
| Authorization matrix, token handling (AC-9.x) | `auth.test.ts` (forged role claim, expired token, deactivated user, no user enumeration) |
| NFR-1 concurrency | `concurrency.test.ts` |
| NFR-3 health, migrations | `integrity.test.ts` |

## 3. Evidence: inventory stays correct

1. **Invariant checks.** `on_hand == Σ ledger.quantity_change` for every product, `received_quantity <= expected_quantity`
   for every item, and every ledger row's `balance_after` equals the running sum — asserted after the mixed workload in
   `integrity.test.ts` and after the concurrency suite.
2. **Concurrency.** 10 parallel receipts of 1 against 5 remaining → exactly 5 succeed, 5 are refused, final stock is 5 and the
   ledger balances read `1,2,3,4,5`. 8 × 30 against 100 → exactly 3 win, stock 90.
3. **Duplicates.** The same `Idempotency-Key` sent 8× in parallel is applied once (1×201, 7×200, same receipt id, stock 7).
   A retry without a key is a *new* receipt and is still bounded by the remaining quantity.
4. **Invalid operations leave no trace.** Every rejection test re-reads the item, document, inventory and ledger and asserts
   they are unchanged.
5. **Database as last line of defence.** Raw SQL that tries to over-receive, drive stock negative or edit the ledger is rejected
   by constraints/trigger (`integrity.test.ts`).
6. **Live run** (production build, fresh database, step 4 of §5). Result straight from PostgreSQL after the e2e script:

```
      sku       | on_hand | ledger_sum | matches
----------------+---------+------------+---------
 E2E-A-MVTBVMH6 |      15 |         15 | t
 E2E-B-MVTBVMH6 |       4 |          4 | t
 over_received_items = 0 (of 4 items)
```

## 4. Do the tests actually catch bugs? (mutation check)

Each row: one rule was deliberately broken in the source, the full suite was run, then the change was reverted.

| Mutation | Suite result |
|----------|--------------|
| Remove the application over-receipt check (BR-06) | **killed** — 2 tests fail |
| Remove the `FOR UPDATE` lock on the document row | **killed** — 2 fail |
| Skip the receipt status gate (BR-07) | **killed** — 2 fail |
| Do not update inventory (BR-09) | **killed** — 10 fail |
| Do not append ledger rows (BR-09) | **killed** — 17 fail |
| Complete without checking item quantities (BR-10) | **killed** — 5 fail |
| Disable idempotency lookup (BR-13) | **killed** — 3 fail |
| Let operators cancel (authorization) | **killed** — 2 fail |
| Coerce string quantities to numbers | **killed** — 7 fail |
| Allow cancel after partial receipt (BR-11) | **killed** — 3 fail |
| Remove `BEGIN` (no real transaction) | **killed** — 7 fail |

Findings from this exercise (kept honest):

- The first version of the "rollback" mutant (replace `ROLLBACK` with `COMMIT`) **survived**, and so did the whole suite. Two
  reasons: that mutant is behaviourally equivalent (PostgreSQL turns `COMMIT` of an aborted transaction into a rollback), *and*
  my receipt validates all lines before writing, so no existing test failed halfway through a write. I added a test that
  installs a trigger making line 2's ledger insert fail after line 1 was written, and asserts everything is rolled back
  (`integrity.test.ts`, "rollback on a failure in the MIDDLE of a receipt"). The `BEGIN`-removal mutant is killed by it.
- One mutation slot (`M7`) was a placeholder that changed nothing; it is not counted above.
- Mutation testing here was done by hand with a throw-away script, not a framework; it covers the 11 mutants above, not every line.

## 5. Manual verification performed on the build

1. `npm run build` for backend (tsc, strict) and frontend (tsc + vite) — pass.
2. Production-style install in a clean directory (`npm ci --omit=dev`, compiled `dist/`) — the same steps as the Dockerfile.
3. `migrateCli` run twice on an empty database: first creates schema and users, second reports "up to date / already exists".
4. API started from `dist/`, SPA served with an `/api` proxy (as nginx does), `scripts/e2e-smoke.mjs` run through it: **32/32 checks passed**
   (auth, role rules, partial/full receipts, over-receipt, atomic rejection, idempotent replay, completion rules, history, 12-way
   parallel receipt, cancellation).
5. API refuses to start with an invalid `JWT_SECRET` (fail-fast configuration).
6. `docker compose config` validates the compose file.

## 6. Manual UI checklist

Not automated. Log in as each role and confirm:

- [ ] Operator sees no "New product", "Edit", "Complete" or "Cancel" buttons; supervisor sees them.
- [ ] Create a product (supervisor); duplicate SKU shows a readable error.
- [ ] New document: product dropdown lists only active products; a product can be chosen only once.
- [ ] Document detail: enter a quantity above "Remaining" → inline error, nothing sent; enter a valid one → "Receipt recorded", numbers and status update.
- [ ] Double-click "Record receipt" quickly → only one receipt appears (button disabled while in flight).
- [ ] "Fill all remaining" then record → status "Fully received"; "Complete document" appears for the supervisor only.
- [ ] Inventory shows the new totals; History shows newest-first entries linking back to the document.
- [ ] Token expiry / logout returns to the login screen.

## 7. Known limitations and unresolved issues

**Verification gaps**
- **The Docker images were not built or run in the authoring environment**: the sandbox blocks Docker Hub, so base images could not be pulled. The Dockerfiles and Compose file are validated syntactically (`docker compose config`) and every step they perform was executed natively (§5), but `docker compose up` itself has **not** been exercised. Run it once on your machine before submitting and fix anything it reveals.
- **The UI was never opened in a browser** here (none available). It is type-checked, built, and the API calls it makes are covered by tests, but layout and interaction are unverified until the §6 checklist is done.
- No automated frontend tests (component or Playwright). No load test for NFR-4.

**Product / security limitations** (all candidates for follow-up work)
- No login rate limiting or account lockout.
- JWT is kept in `sessionStorage` (exposed to XSS if one existed; avoids CSRF). No refresh tokens or server-side revocation beyond the per-request `is_active` check.
- No user management UI; changing a seeded user's password requires a database update (the seed never overwrites).
- Receipts cannot be reversed and documents cannot be edited (PRD A3, A4); a future *adjustment* transaction type would address this.
- Idempotency keys are global and never expire.
- Search uses `ILIKE` without a trigram index — fine for the assumed scale, would need `pg_trgm` for very large catalogues.
- Document numbers can have gaps (sequence semantics, PRD A10).
- The new-document form loads at most 1,000 active products into its dropdown.
- Unresolved business questions are listed in PRD §9.3.
