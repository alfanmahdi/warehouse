import pg from 'pg';
import { runMigrations } from '../src/migrate.js';
import { createPool } from '../src/db.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/warehouse_test';

/** Resets the TEST database to an empty schema and applies all migrations once per test run. */
export default async function setup(): Promise<void> {
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace('/', '');
  // Safety: this script DROPs the public schema. Never let it run against a non-test database.
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to reset database "${dbName}": its name must contain "test". Set TEST_DATABASE_URL.`);
  }

  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const pool = createPool(TEST_DATABASE_URL);
  try {
    await runMigrations(pool, undefined, () => undefined);
  } finally {
    await pool.end();
  }
}
