# Agent task instructions

These are the task instructions given to the AI coding agent, in order. Each one is deliberately short and
**points at the specification instead of restating it** — the PRD, technical spec, OpenAPI contract and
`CLAUDE.md` are the real inputs. A task never asks the agent to "decide" business behaviour.

| # | File | Spec inputs |
|---|------|-------------|
| 1 | [01-schema-and-migrations.md](01-schema-and-migrations.md) | `erd.mmd`, tech-spec §3–4 |
| 2 | [02-receiving-service.md](02-receiving-service.md) | PRD §5–6, tech-spec §7–8 |
| 3 | [03-api-and-auth.md](03-api-and-auth.md) | `openapi.yaml`, tech-spec §5, §9 |
| 4 | [04-tests.md](04-tests.md) | PRD §7 (acceptance criteria), tech-spec §11 |
| 5 | [05-frontend.md](05-frontend.md) | PRD §4.6, `openapi.yaml` |
| 6 | [06-docker-and-deploy.md](06-docker-and-deploy.md) | tech-spec §4.3, §10 |
