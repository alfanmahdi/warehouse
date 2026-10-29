# Product Requirements Document — Warehouse Receiving System

| | |
|---|---|
| Version | 1.0 |
| Status | Approved for implementation |
| Audience | Developers and AI coding agents implementing the system |

> This PRD is the source of truth for **what** the system does. The technical specification
> (`technical-spec.md`) is derived from it and describes **how**. Every business rule has an ID
> (`BR-xx`) that is referenced by the API contract, the code and the tests.

---

## 1. Problem statement and business objectives

### 1.1 Problem

The warehouse records incoming inventory in spreadsheets. This causes:

- **Over-receipt and typos**: nothing stops an operator from entering more units than were ordered.
- **No audit trail**: when a stock number is wrong nobody can tell who changed it or when.
- **Unclear document status**: it is not visible which deliveries are open, partly received or closed.
- **Stock drift**: the "available stock" sheet and the "received" sheet are edited separately and diverge.

### 1.2 Objectives

| ID | Objective | Measure of success |
|----|-----------|--------------------|
| O1 | Register inbound deliveries as structured receiving documents | 100% of deliveries have a document with expected quantities |
| O2 | Make it impossible to receive more than expected | Over-receipt attempts are rejected by the backend, always |
| O3 | Keep stock automatically correct | `on_hand` for every product always equals the sum of its ledger entries |
| O4 | Provide a full audit trail | Every stock change has who/when/which document |
| O5 | Make progress visible | Each document shows a status and per-item received/remaining quantities |

---

## 2. User roles and responsibilities

| Role | Who | Responsibilities |
|------|-----|------------------|
| **Warehouse Operator** (`OPERATOR`) | Floor staff handling trucks and pallets | Creates receiving documents from delivery paperwork, counts goods, records received quantities, looks up stock |
| **Warehouse Supervisor** (`SUPERVISOR`) | Team lead / inventory controller | Everything an operator does, plus: manages the product master data, verifies and **completes** receiving documents, **cancels** documents created in error |

### 2.1 Permission matrix

| Capability | Operator | Supervisor |
|------------|:-------:|:----------:|
| Log in, view own profile | ✅ | ✅ |
| View products, documents, inventory, transaction history | ✅ | ✅ |
| Create / edit products (incl. activate / deactivate) | ❌ | ✅ |
| Create receiving documents | ✅ | ✅ |
| Record receipts (partial or full) | ✅ | ✅ |
| Complete a receiving document | ❌ | ✅ |
| Cancel a receiving document | ❌ | ✅ |

Rationale: product master data and the final sign-off of a document are control points, so they
are restricted to the supervisor. Day-to-day receiving must not be blocked, so operators can create
documents and record receipts.

---

## 3. Scope

### 3.1 In scope

1. Product master data (SKU, name, description, active flag).
2. Receiving documents with line items and expected quantities.
3. Recording partial and full receipts against document items.
4. Automatic inventory update and an append-only inventory transaction ledger.
5. Document status tracking and the status transition rules.
6. Inventory listing and transaction history viewing.
7. Authentication (username/password) and role-based authorization.
8. A web UI for all of the above.

### 3.2 Out of scope (explicitly not built)

- Outbound/picking/shipping, stock transfers, stock adjustments, cycle counts, returns.
- Multiple warehouses, storage locations/bins, lots/batches, expiry dates, serial numbers.
- Units of measure and conversions (all quantities are whole units, "pieces").
- Editing a receiving document's items after creation (cancel and re-create instead).
- Reversing/undoing a receipt (would be a future "adjustment" feature, see §9).
- Suppliers master data (supplier is a free-text field).
- User management UI, password reset, SSO, MFA (users are provisioned by a seed command).
- Notifications, barcode scanning, printing, reporting/exports, multi-language UI.
- Purchase order integration.

---

## 4. Functional requirements

### 4.1 Authentication & authorization

| ID | Requirement |
|----|-------------|
| FR-AUTH-1 | A user logs in with username and password and receives a signed token valid for 8 hours. |
| FR-AUTH-2 | All endpoints except login and health require a valid token. Missing/invalid/expired token → 401. |
| FR-AUTH-3 | Role checks are enforced by the backend per endpoint (see §2.1). Insufficient role → 403. |
| FR-AUTH-4 | The UI hides actions the current role cannot perform, but the backend never relies on that. |
| FR-AUTH-5 | Passwords are stored only as salted hashes. Deactivated users cannot log in. |

### 4.2 Products

| ID | Requirement |
|----|-------------|
| FR-PROD-1 | List products, with text search (SKU or name), optional `active` filter, pagination. |
| FR-PROD-2 | Create a product with SKU, name and optional description (supervisor). |
| FR-PROD-3 | Update a product's name, description and active flag (supervisor). **SKU is immutable.** |
| FR-PROD-4 | View a single product. |

### 4.3 Receiving documents

| ID | Requirement |
|----|-------------|
| FR-DOC-1 | Create a document with: supplier name (required), reference number (optional, e.g. PO or delivery-note number), expected date (optional), notes (optional) and 1–100 items (product + expected quantity). |
| FR-DOC-2 | The system generates a unique, human-readable document number `RCV-000001`, `RCV-000002`, … |
| FR-DOC-3 | A new document starts in status `OPEN`. |
| FR-DOC-4 | List documents with status filter, text search (document number, supplier, reference), pagination, newest first. Each row shows status and total expected / total received. |
| FR-DOC-5 | Document detail shows header data, status, items with expected / received / remaining quantities and the receipts recorded against it. |
| FR-DOC-6 | Complete a document (supervisor) — only allowed when every item is fully received (BR-10). |
| FR-DOC-7 | Cancel a document (supervisor) — only allowed when nothing has been received (BR-11). |

### 4.4 Receiving (recording received quantities)

| ID | Requirement |
|----|-------------|
| FR-RCV-1 | A **receipt** is one submission containing one or more lines `{itemId, quantity}` against one document. The user may receive any subset of the items, any quantity up to the remaining amount. |
| FR-RCV-2 | A receipt is **atomic**: if any line is invalid, nothing is recorded (BR-08). |
| FR-RCV-3 | On success the system, in one database transaction, increases `received_quantity` on each item, increases inventory on-hand for each product, writes one inventory transaction per line, and recomputes the document status. |
| FR-RCV-4 | A receipt may carry an idempotency key. Re-submitting the same key with the same content returns the original result and changes nothing (BR-13). |

### 4.5 Inventory

| ID | Requirement |
|----|-------------|
| FR-INV-1 | List inventory: one row per product with SKU, name, quantity on hand. Includes products with zero stock. Search and pagination supported. |
| FR-INV-2 | List inventory transactions (the ledger): newest first, filter by product, pagination. Each row shows product, quantity change, balance after, source document, user, timestamp. |

### 4.6 User interface

Screens: Login · Products (list + create/edit dialog) · Receiving documents (list, create, detail with
"record receipt", "complete", "cancel") · Inventory · Transaction history.
The UI must show backend validation errors to the user in plain language and must prevent
double-submission of a receipt while a request is in flight.

---

## 5. Business rules and validation

### 5.1 Business rules

| ID | Rule |
|----|------|
| **BR-01** | SKU is unique across all products (case-insensitive). It is stored upper-case, matches `^[A-Z0-9][A-Z0-9_-]{1,31}$`, and cannot change after creation. |
| **BR-02** | Product name is required (1–200 characters after trimming). |
| **BR-03** | Inactive products cannot be added to **new** documents. Documents that already contain an inactive product can still be received (goods have physically arrived). |
| **BR-04** | A document has 1–100 items, and each product appears at most once per document. |
| **BR-05** | Expected quantity is a whole number from 1 to 1,000,000. |
| **BR-06** | A received quantity on a line is a whole number ≥ 1 and **must not exceed the item's remaining quantity** (`expected − received`). Over-receipt is never allowed, for any role. |
| **BR-07** | Receipts can only be recorded while the document is `OPEN` or `PARTIALLY_RECEIVED`. |
| **BR-08** | A receipt is all-or-nothing. A request with several lines where one line is invalid records nothing. |
| **BR-09** | Every recorded receipt line updates inventory on-hand and appends an inventory transaction, within the same database transaction as the item update. |
| **BR-10** | A document can be completed **only if every item has `received_quantity == expected_quantity`**. The check is made against item data at completion time, not against the cached status. Supervisor only. |
| **BR-11** | A document can be cancelled only while `OPEN` (nothing received). Supervisor only. |
| **BR-12** | `COMPLETED` and `CANCELLED` are terminal: no further changes of any kind. |
| **BR-13** | Idempotency: the same `Idempotency-Key` on the same document with the same lines is applied once; replays return the original result with HTTP 200. The same key reused for a different document or different lines is rejected (409). |
| **BR-14** | Inventory on-hand is never negative. The ledger is append-only (no update/delete). For every product, `on_hand == sum(ledger.quantity_change)`. |
| **BR-15** | Status is derived by the system: `OPEN` (nothing received) → `PARTIALLY_RECEIVED` (some received) → `FULLY_RECEIVED` (all items fully received). Users never set these three directly. |
| **BR-16** | Documents and products are never deleted (only cancelled / deactivated). |

### 5.2 Field validation

| Field | Rule |
|-------|------|
| `username` | 3–50 chars, stored lower-case |
| `password` | non-empty on login |
| `sku` | BR-01; trimmed and upper-cased by the server |
| `name` | BR-02 |
| `description` | optional, ≤ 1000 chars |
| `supplierName` | required, 1–200 chars |
| `referenceNumber` | optional, ≤ 100 chars |
| `expectedDate` | optional, `YYYY-MM-DD` valid calendar date |
| `notes` | optional, ≤ 1000 chars |
| `quantity` / `expectedQuantity` | JSON **number**, integer. Strings (`"5"`), decimals (`2.5`), `NaN`, negatives and zero are rejected |
| `Idempotency-Key` | optional header, 1–128 chars |
| Pagination | `limit` 1–100 (default 20), `offset` ≥ 0 |

All validation is done server-side. Client-side validation is a convenience only.

---

## 6. Document status model

```
OPEN ──(receipt, partial)──▶ PARTIALLY_RECEIVED ──(receipt, completes all items)──▶ FULLY_RECEIVED ──(supervisor completes)──▶ COMPLETED
 │  └──(receipt that fills every item at once)──────────────────────────────────────▶ FULLY_RECEIVED
 └──(supervisor cancels, nothing received)──▶ CANCELLED
```

| From | To | Trigger | Condition |
|------|----|---------|-----------|
| `OPEN` | `PARTIALLY_RECEIVED` | receipt | not every item is fully received |
| `OPEN` | `FULLY_RECEIVED` | receipt | every item becomes fully received |
| `PARTIALLY_RECEIVED` | `PARTIALLY_RECEIVED` | receipt | not every item is fully received |
| `PARTIALLY_RECEIVED` | `FULLY_RECEIVED` | receipt | every item becomes fully received |
| `FULLY_RECEIVED` | `COMPLETED` | supervisor completes | BR-10 |
| `OPEN` | `CANCELLED` | supervisor cancels | BR-11 |

Any other transition is rejected with `409 INVALID_STATE`.

---

## 7. User stories and acceptance criteria

### US-1 Manage products
*As a supervisor I want to maintain the product list so receiving documents use correct SKUs.*

- AC-1.1 Given a unique SKU and a name, creating a product returns 201 and the product appears in the list.
- AC-1.2 Given a SKU that exists (even in different case, e.g. `abc-1` vs `ABC-1`), creation fails with 409 `DUPLICATE_SKU`.
- AC-1.3 Given an invalid SKU (`"a b"`, empty, too long) creation fails with 400 `VALIDATION_ERROR`.
- AC-1.4 An operator calling create/update gets 403.
- AC-1.5 Updating a product cannot change its SKU (a `sku` field in the body is rejected).

### US-2 Create a receiving document
*As an operator I want to register an expected delivery so that I can receive against it.*

- AC-2.1 Given a supplier and ≥1 item with valid products and quantities, a document is created with status `OPEN`, a generated number, and `received = 0` on all items.
- AC-2.2 Zero items, > 100 items, a duplicate product, an unknown product, an inactive product, or a quantity that is zero/negative/fractional/non-numeric → rejected, nothing is stored.
- AC-2.3 The document appears in the list with status `OPEN`.

### US-3 Record a partial receipt
*As an operator I want to record what actually arrived, even if it is only part of the delivery.*

- AC-3.1 Expected 10, receive 4 → item shows received 4 / remaining 6; document becomes `PARTIALLY_RECEIVED`; inventory for the product increases by 4; one ledger row (+4, balance after) exists.
- AC-3.2 A second receipt of 6 on the same item → received 10 / remaining 0.
- AC-3.3 Receiving several items in one request updates all of them in one transaction.

### US-4 Prevent over-receipt
*As a supervisor I want the system to refuse quantities above what was expected.*

- AC-4.1 Remaining 6, receive 7 → 422 `OVER_RECEIPT`; item, document, inventory and ledger unchanged.
- AC-4.2 Receive 0, −1, 2.5, `"3"`, `null`, or omit quantity → 400 `VALIDATION_ERROR`; nothing changes.
- AC-4.3 A request with two lines where the second is invalid → the first line is **not** applied either (BR-08).
- AC-4.4 Ten concurrent requests each receiving 1 unit against an item with 5 remaining → exactly 5 succeed, 5 fail with `OVER_RECEIPT`; final received is 5 and inventory is exactly 5.
- AC-4.5 An `itemId` that belongs to another document → 422 `ITEM_NOT_IN_DOCUMENT` (or 404 if the id does not exist anywhere).

### US-5 Safe retries
*As an operator on a flaky Wi-Fi connection I want to retry a submission without double-counting.*

- AC-5.1 Submitting the same receipt twice with the same `Idempotency-Key`: the first returns 201, the second returns 200 with the same receipt id; inventory increased once.
- AC-5.2 The same key with different lines or a different document → 409 `IDEMPOTENCY_KEY_REUSED`.
- AC-5.3 Submitting the same quantities **without** a key is treated as a new receipt (and is still bounded by BR-06).

### US-6 Complete a document
*As a supervisor I want to close a document only when everything was received.*

- AC-6.1 All items fully received, supervisor completes → status `COMPLETED`, `completedBy/At` set.
- AC-6.2 Any item with remaining > 0 → 422 `NOT_FULLY_RECEIVED`, listing the unfinished items.
- AC-6.3 An operator attempting completion → 403.
- AC-6.4 Completing an already completed or cancelled document → 409 `INVALID_STATE`.
- AC-6.5 Receipt attempts on a `COMPLETED`/`CANCELLED`/`FULLY_RECEIVED` document → 409 `INVALID_STATE`.

### US-7 Cancel a document
- AC-7.1 Supervisor cancels an `OPEN` document → `CANCELLED`; inventory unaffected.
- AC-7.2 Cancelling a `PARTIALLY_RECEIVED`, `FULLY_RECEIVED`, `COMPLETED` or already `CANCELLED` document → 409 `INVALID_STATE`.
- AC-7.3 Operator → 403.

### US-8 View inventory and history
- AC-8.1 Inventory lists every product with on-hand quantity (0 if never received).
- AC-8.2 The transaction list shows newest first and can be filtered by product.
- AC-8.3 For every product, on-hand equals the sum of its ledger changes.

### US-9 Authentication
- AC-9.1 Valid credentials → token and user profile; invalid credentials → 401 with a generic message (no hint whether the username exists).
- AC-9.2 No token / bad token / expired token on a protected endpoint → 401.

---

## 8. Non-functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Correctness | Stock changes are transactional and safe under concurrent requests (row locks + database CHECK constraints as a second line of defence). |
| NFR-2 | Security | Passwords hashed with bcrypt; JWT secret from environment; no secrets in the repository; security headers; parameterised SQL only; role checks on the server. |
| NFR-3 | Reliability | `GET /api/health` (liveness) and `GET /api/health/ready` (checks DB) endpoints; migrations are idempotent and guarded by an advisory lock so concurrent starts are safe. |
| NFR-4 | Performance | List endpoints respond < 300 ms for 10,000 products / 50,000 ledger rows on a single small instance (indexed, paginated). |
| NFR-5 | Observability | One structured log line per request (method, path, status, duration, user id); errors logged with stack. |
| NFR-6 | Portability | Whole stack runs with `docker compose up`; all configuration via environment variables. |
| NFR-7 | Maintainability | TypeScript, layered code (routes → services → SQL), documented API (OpenAPI), automated tests for all business rules. |
| NFR-8 | Usability | Primary workflow (create document → receive → complete) reachable in ≤ 3 clicks from the document list; errors shown inline. |
| NFR-9 | Auditability | Ledger is append-only and enforced by a database trigger. |
| NFR-10 | Time | All timestamps stored as UTC (`timestamptz`) and rendered in the browser's local time. |

---

## 9. Assumptions, constraints and unresolved questions

### 9.1 Assumptions (decisions made because the brief was unclear)

| # | Assumption | Why |
|---|------------|-----|
| A1 | There is one warehouse and quantities are whole units. | Brief mentions neither locations nor units of measure. |
| A2 | "Completing" a document is an explicit supervisor action, not automatic when the last unit is received. | The brief says a document "must not be completed unless all items have been fully received", which implies a deliberate action with a guard. A supervisor sign-off also gives a verification step. Hence the extra status `FULLY_RECEIVED` between "all received" and "signed off". |
| A3 | Receipts cannot be undone. Mistakes are handled outside this system for now. | Reversal needs an adjustment workflow that is not in the brief; the ledger design (append-only) leaves room for it. |
| A4 | Documents are not editable after creation; cancel (only possible before any receipt) and re-create. | Keeps the state model small and the expected quantities trustworthy. |
| A5 | Only supervisors manage products and complete/cancel documents. | Control points. Easy to relax via the permission table. |
| A6 | Over-receipt is blocked for everyone; there is no supervisor override. | The brief states the application must prevent it. |
| A7 | Inactive products may still be received on documents that already include them. | Physical goods are already there. |
| A8 | Supplier is free text. | No supplier master data in the brief. |
| A9 | Users are pre-provisioned (seed command) with two roles; no self-registration. | Brief asks only for "basic authentication or equivalent". |
| A10 | The document number is generated by the database sequence; gaps are possible if a creation transaction fails. | Standard sequence behaviour; gaplessness is not required. |

### 9.2 Constraints

- PostgreSQL as the relational database; REST API; Docker for deployment.
- Target effort 8–12 hours — so no features beyond §3.1.

### 9.3 Unresolved questions (to confirm with the warehouse team)

1. Should a supervisor be able to receive **above** the expected quantity with a recorded reason (tolerance, e.g. ±5%)? Currently: never.
2. How are wrongly recorded receipts corrected? Proposal: a supervisor-only "adjustment" transaction with a mandatory reason.
3. Do products need units of measure (pallet / carton / piece) and conversion?
4. Is a document allowed to be closed **short** (supplier will never deliver the rest)? Currently: no — it can only be completed when fully received, and cancelled only when nothing was received.
5. Are damaged / rejected goods tracked separately from accepted goods?
6. Is a per-user audit view or export required?
7. Password policy, rotation and account lockout requirements.
