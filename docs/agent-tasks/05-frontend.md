# Task 5 — Frontend

**Read first:** PRD §2.1 (permission matrix) and §4.6 (screens), `docs/openapi.yaml`.

**Do:** React + Vite + TypeScript SPA: Login, Products, Receiving list / new / detail (record receipt, complete, cancel),
Inventory, History. Requirements that come from the spec: show server error messages verbatim and readable; disable the
submit button while a receipt is in flight; send one `Idempotency-Key` per distinct submission and reuse it only when the
identical payload is retried; hide actions the role cannot perform (but never rely on that).

**Do not:** duplicate business rules as the source of truth — client checks are convenience only.

**Done when:** `npm run build` (includes type-check) passes and the main workflow is reachable in ≤ 3 clicks (NFR-8).
