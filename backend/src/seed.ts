import bcrypt from 'bcryptjs';
import type { Pool } from './db.js';

export interface SeedOptions {
  operatorPassword?: string | undefined;
  supervisorPassword?: string | undefined;
  bcryptRounds: number;
}

const SEED_USERS = [
  { username: 'operator', fullName: 'Warehouse Operator', role: 'OPERATOR', key: 'operatorPassword' },
  { username: 'supervisor', fullName: 'Warehouse Supervisor', role: 'SUPERVISOR', key: 'supervisorPassword' },
] as const;

/**
 * Ensures the demo users exist. Passwords come from the environment — nothing is hard-coded or committed.
 * Idempotent: an existing user is never modified (a changed password is NOT applied; see README).
 */
export async function seedUsers(pool: Pool, options: SeedOptions, log: (msg: string) => void = console.log): Promise<void> {
  for (const u of SEED_USERS) {
    const password = options[u.key];
    if (!password) {
      log(`skipping user "${u.username}" (no password provided)`);
      continue;
    }
    const hash = await bcrypt.hash(password, options.bcryptRounds);
    const res = await pool.query(
      `INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, u.fullName, hash, u.role],
    );
    log(res.rowCount ? `created user "${u.username}" (${u.role})` : `user "${u.username}" already exists`);
  }
}
