# Task 4 — Automated tests against a real PostgreSQL

**Read first:** PRD §7 (every `AC-x.y`), tech-spec §11.

**Do:** one test per acceptance criterion, named with its `AC` id, in Vitest + Supertest on a real database:
validation boundaries (0, -1, 2.5, "3", null, 1,000,001), over-receipt, multi-line atomicity, idempotent replay and
reuse, completion/cancellation guards, role matrix, concurrency (parallel receipts, same-key replays, opposite lock
orders, receive-vs-cancel races), and **invariants** after each suite: `on_hand == Σ ledger`, `received <= expected`.
Add raw-SQL tests proving the database itself rejects bad data (CHECKs, append-only trigger).

**Then check the tests themselves:** temporarily break each business rule in the source (remove the over-receipt check,
the row lock, the status gate, the ledger insert, …) and confirm the suite goes red. Report any mutation that survives.

**Done when:** all green, and every surviving mutation is explained or fixed with a new test.
