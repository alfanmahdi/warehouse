# Task 1 — Schema and migration runner

**Read first:** `CLAUDE.md`, `docs/erd.mmd`, `docs/technical-spec.md` §3 (constraints) and §4 (database design, migration strategy).

**Do:**
1. Write `backend/migrations/001_init.sql` for every entity in the ERD. Put each rule that can be a database
   constraint into the database (BR-01 SKU format/unique, BR-05 quantity range, BR-06 `received <= expected`,
   BR-14 `on_hand >= 0` and the append-only ledger trigger).
2. Write `backend/src/migrate.ts`: ordered `NNN_*.sql`, one transaction per file, advisory lock, checksum
   recorded, error if an applied file was edited. Idempotent.
3. `backend/src/seed.ts`: create `operator` / `supervisor` users from environment passwords only; never overwrite.

**Do not:** hard-code any password; add tables that are not in the ERD.

**Done when:** a fresh database migrates; running again is a no-op; a deliberately broken migration leaves no partial table.
