#!/usr/bin/env sh
# Generates .env with random secrets. Refuses to overwrite an existing file unless --force is given.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ] && [ "${1:-}" != "--force" ]; then
  echo ".env already exists — leaving it untouched (use --force to regenerate)." >&2
  exit 0
fi

rand() { # $1 = number of random bytes, output hex
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

OPERATOR_PW="$(rand 9)"
SUPERVISOR_PW="$(rand 9)"

umask 077
cat > .env <<ENV
POSTGRES_USER=warehouse
POSTGRES_PASSWORD=$(rand 24)
POSTGRES_DB=warehouse
JWT_SECRET=$(rand 32)
JWT_EXPIRES_IN_SECONDS=28800
BCRYPT_ROUNDS=10
SEED_OPERATOR_PASSWORD=${OPERATOR_PW}
SEED_SUPERVISOR_PASSWORD=${SUPERVISOR_PW}
WEB_PORT=8080
ENV

echo "Created .env with fresh random secrets (file is git-ignored)."
echo
echo "Demo logins (also stored in .env):"
echo "  operator    / ${OPERATOR_PW}"
echo "  supervisor  / ${SUPERVISOR_PW}"
