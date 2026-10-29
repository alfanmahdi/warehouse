import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.js';

/** Arbitrary constant used as the advisory-lock key so concurrent runners serialise (technical-spec §4.3). */
const MIGRATION_LOCK_KEY = 727_001;

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Applies pending `NNN_name.sql` files in order, each in its own transaction.
 * Re-running is a no-op. A changed already-applied file is an error (migrations are immutable).
 * Returns the list of files applied in this run.
 */
export async function runMigrations(
  pool: Pool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM schema_migrations')).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = sha256(sql);
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after it was applied. Create a new migration instead.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
    if (applied.length === 0) log('database schema is up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
