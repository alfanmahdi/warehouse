# Task 6 — Containerisation and reproducible deployment

**Read first:** tech-spec §4.3 (migrations), §10 (environment variables), `docs/architecture.mmd`.

**Do:** multi-stage Dockerfiles (backend, frontend+nginx), `docker-compose.yml` with `db` → one-shot `migrate` →
`api` (healthcheck on `/api/health/ready`) → `web`. All configuration from environment variables; the DB port is not
published. `scripts/init-env.sh` generates random secrets (nothing secret is committed). `scripts/e2e-smoke.mjs` runs
the main workflow through the public entry point.

**Do not:** commit `.env`; use default passwords; run the API as root.

**Done when:** from a clean checkout `node scripts/init-env.mjs && docker compose up --build` serves the UI and
`node scripts/e2e-smoke.mjs` passes.
