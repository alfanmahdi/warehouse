import bcrypt from 'bcryptjs';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';
import { signToken, type AuthUser, type Role } from '../http/auth.js';
import { unauthenticated } from '../errors.js';

let dummyHash: string | undefined;

/** Used so that a login for an unknown user costs the same as a wrong password (no user enumeration by timing). */
function getDummyHash(rounds: number): string {
  dummyHash ??= bcrypt.hashSync('not-a-real-password', rounds);
  return dummyHash;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: AuthUser;
}

export async function login(
  pool: Pool,
  config: Pick<Config, 'JWT_SECRET' | 'JWT_EXPIRES_IN_SECONDS' | 'BCRYPT_ROUNDS'>,
  username: string,
  password: string,
): Promise<LoginResult> {
  const { rows } = await pool.query<{
    id: number;
    username: string;
    full_name: string;
    role: Role;
    password_hash: string;
    is_active: boolean;
  }>('SELECT id, username, full_name, role, password_hash, is_active FROM users WHERE username = $1', [
    username.trim().toLowerCase(),
  ]);
  const row = rows[0];

  const ok = await bcrypt.compare(password, row?.password_hash ?? getDummyHash(config.BCRYPT_ROUNDS));
  if (!row || !row.is_active || !ok) {
    // Same message for unknown user, wrong password and deactivated account (FR-AUTH-5, AC-9.1).
    throw unauthenticated('Invalid username or password');
  }

  const user: AuthUser = { id: row.id, username: row.username, fullName: row.full_name, role: row.role };
  return { token: signToken(user, config), expiresIn: config.JWT_EXPIRES_IN_SECONDS, user };
}
