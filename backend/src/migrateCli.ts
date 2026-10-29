/** Entry point of the one-shot `migrate` job: apply migrations, then seed users. Exits non-zero on failure. */
import { loadMigrateConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { seedUsers } from './seed.js';

async function main(): Promise<void> {
  const config = loadMigrateConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    await runMigrations(pool);
    await seedUsers(pool, {
      operatorPassword: config.SEED_OPERATOR_PASSWORD,
      supervisorPassword: config.SEED_SUPERVISOR_PASSWORD,
      bcryptRounds: config.BCRYPT_ROUNDS,
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
