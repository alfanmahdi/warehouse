# AI Agent Workflow

> **Candidate note:** this file describes how the work was actually done. If your own process differed (you gave
> different prompts, reviewed different things, or changed anything by hand), edit it so it stays true — the technical
> review will ask you to explain and defend every part.

## 1. Agent and setup

| | |
|---|---|
| Agent | Claude (Sonnet 5.5) running as a coding agent with file, shell and test-running tools |
| Human role | Supplied the assessment brief and the job posting, directed the work, reviews and owns the result |
| Project inputs given to the agent | `docs/prd.md`, `docs/technical-spec.md`, `docs/openapi.yaml`, `docs/erd.mmd`, `backend/migrations/001_init.sql`, **`CLAUDE.md`** (project instruction file) |
| Task instructions | `docs/agent-tasks/01…06` (short, they point at the spec instead of restating it) |

## 2. Method: specification first, code second

```
Assessment brief ─▶ PRD (with numbered rules BR-xx, acceptance criteria AC-x.y)
                 ─▶ Technical spec + ERD + OpenAPI + SQL DDL + diagrams
                 ─▶ CLAUDE.md  (rules the agent must follow, spec priority, commands, definition of done)
                 ─▶ Task 1…6 instructions  ─▶ code + tests ─▶ verify ─▶ commit
```

1. **Requirements were written before any code.** The brief says the requirements are unclear, so ten assumptions and seven
   open questions were made explicit in PRD §9 (e.g. completion is an explicit supervisor action, which introduced the
   `FULLY_RECEIVED` status; over-receipt has no override).
2. **Business rules got IDs** (`BR-01…BR-16`) so they can be cited in the API contract, in code comments, in task
   instructions and in test names. The agent is told in `CLAUDE.md` that docs win over code and that unspecified behaviour is
   recorded as an assumption instead of guessed.
3. **The riskiest logic was specified in detail before it was implemented**: lock order, transaction steps and a threat table
   (technical-spec §7) — the implementation in `services/receiving.ts` follows those numbered steps.
4. **Work was split into six tasks** (below), each with inputs, constraints ("do not…") and a definition of done.
5. **Every task ended with verification**, not with "looks right" (§4).

## 3. Prompts / task instructions (≥ 3 meaningful ones)

### Prompt 0 — the opening request (human)
> *Attached: the technical-assessment PDF and the job posting (Fullstack Developer, Paid Internship).*
> "here is the technical test — I want you to help me do this technical test."

The agent responded by reading the brief, planning the deliverables, and starting with documentation (PRD → technical spec).

### Task instructions given to the agent
The full text of each is in [`agent-tasks/`](agent-tasks/README.md). Summary of what each one demonstrates:

| # | Task | What it shows about the approach |
|---|------|----------------------------------|
| 1 | Schema & migration runner | Rules pushed into the database (CHECKs, append-only trigger) so the DB defends itself even if code is wrong |
| 2 | Receiving service | One transaction with an exact lock order; "do not" list forbids a supervisor override and string coercion |
| 3 | REST API & auth | Contract-first: routes must match `openapi.yaml`; role checked before validation; role read from DB, not from the token |
| 4 | Tests **and mutation check** | One test per acceptance criterion; then deliberately break the code to prove tests can fail |
| 5 | Frontend | Server stays the source of truth; idempotency key per submission; no double-submit |
| 6 | Docker & deploy | Secrets generated, never committed; migrate as a one-shot job before the API starts |

## 4. How the agent's output was evaluated

| Check | What it caught / confirmed |
|-------|----------------------------|
| Strict TypeScript compile + frontend type-check | A missing `@types/node` for the Vite config |
| 226 automated tests on a real PostgreSQL | Behaviour of every BR/AC, incl. parallel receipts |
| **Mutation check** (break a rule, expect red) | 11 mutants killed. One survived and showed a real gap: nothing proved rollback of a failure *in the middle* of a receipt, because the code validates before writing. A test with an injected DB failure was added |
| Reviewing the agent's own tests | Two tests were mislabelled/confusing (one claimed to test the API mapping but only ran raw SQL; the seeding test asserted the wrong thing) and were rewritten; a proper unit test of the error mapping was added |
| Running the production build against a fresh DB + e2e script | 32/32 end-to-end checks; migrate job idempotent; API refuses to start on bad config |
| Honest reporting of what could not be verified | Docker Hub was unreachable in the authoring sandbox → images not built there; no browser → UI not opened. Both listed in [`testing.md`](testing.md#7-known-limitations-and-unresolved-issues) |

## 5. Things a reviewer should know the agent decided (and why)

- **No ORM**, raw parameterised SQL, so the transaction and locking logic is visible in one file.
- **Lock order** document → items (by `product_id`) → inventory rows (ascending `product_id`) to avoid deadlocks.
- **Idempotency check runs before the status check**, so replaying the receipt that completed a document still returns 200.
- **Role from the database on every request**, so deactivation and role changes apply immediately.
- **Validation before writes inside the transaction** (atomicity is then double-guaranteed by rollback).

## 6. Where AI output must not be trusted blindly (my own review list)

Before the technical review, be able to explain without looking: the 10 steps of `recordReceipt()`; why `FOR UPDATE` is on the
document row; why the CHECK constraint exists when the app also validates; what `Idempotency-Key` protects against and what
it does not; why `COMPLETE` re-queries item data; why tests use a real database. See the "Trace a receipt" guide in the
[README](../README.md#trace-a-receipt-from-click-to-database).
