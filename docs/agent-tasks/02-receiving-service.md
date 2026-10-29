# Task 2 — Receiving service (the core)

**Read first:** `CLAUDE.md` rules 2–3, PRD §5.1 (BR-06…BR-15), §6 (status model), tech-spec §7 (API flow, lock order) and §7.1 (threat table).

**Do:** implement `backend/src/services/receiving.ts` and `documentStatus.ts`:
- `recordReceipt()` as ONE transaction in exactly this order: lock document row → idempotency check → status gate →
  lock item rows (by product_id) → validate **every** line → insert receipt → per line (ascending product_id) update
  item, upsert inventory, append ledger → derive status → commit.
- `completeDocument()` must re-check item quantities, not only the status (BR-10).
- `cancelDocument()` only for OPEN (BR-11).
- The status model is a pure transition table, unit-testable without a database.

**Do not:** write stock anywhere else; coerce string quantities; add an override for over-receipt (A6).

**Done when:** each rule above is reachable by a test in Task 4, including a concurrent-receipt test.
