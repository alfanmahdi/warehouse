# Task 3 — REST API, authentication and authorization

**Read first:** `docs/openapi.yaml` (the contract), tech-spec §5 (conventions, error mapping) and §9 (authorization, order of checks).

**Do:** Express routes that match `openapi.yaml` exactly — paths, status codes, error codes, the
`{error:{code,message,details}}` envelope, `.strict()` bodies (unknown fields rejected). JWT login; the user and role are
re-read from the database on every request. Role is checked **before** body validation.
Health endpoints: `/api/health` and `/api/health/ready` (DB check).

**Do not:** put business rules in route files; return stack traces or SQL in errors; trust the role claim inside the token.

**Done when:** every row of the tech-spec §5 endpoint table behaves as listed.
