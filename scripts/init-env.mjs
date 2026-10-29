#!/usr/bin/env node
/**
 * Cross-platform equivalent of init-env.sh (Windows / macOS / Linux). Needs only Node >= 18.
 * Generates .env with random secrets. Won't overwrite an existing .env unless --force is passed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

if (existsSync(envPath) && !process.argv.includes('--force')) {
  console.log(`.env already exists at ${envPath}\nLeaving it untouched. Use --force to regenerate (this also resets the database password, so run "docker compose down -v" first).`);
  process.exit(0);
}

const hex = (bytes) => randomBytes(bytes).toString('hex');
const operatorPw = hex(9);
const supervisorPw = hex(9);

writeFileSync(
  envPath,
  [
    'POSTGRES_USER=warehouse',
    `POSTGRES_PASSWORD=${hex(24)}`,
    'POSTGRES_DB=warehouse',
    `JWT_SECRET=${hex(32)}`,
    'JWT_EXPIRES_IN_SECONDS=28800',
    'BCRYPT_ROUNDS=10',
    `SEED_OPERATOR_PASSWORD=${operatorPw}`,
    `SEED_SUPERVISOR_PASSWORD=${supervisorPw}`,
    'WEB_PORT=8080',
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log(`Created ${envPath} with fresh random secrets (git-ignored).\n`);
console.log('Demo logins (also stored in .env):');
console.log(`  operator    / ${operatorPw}`);
console.log(`  supervisor  / ${supervisorPw}`);
