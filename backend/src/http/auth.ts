import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';
import { forbidden, unauthenticated } from '../errors.js';

export type Role = 'OPERATOR' | 'SUPERVISOR';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface TokenPayload {
  sub: string;
  role: Role;
  username: string;
}

export function signToken(user: AuthUser, config: Pick<Config, 'JWT_SECRET' | 'JWT_EXPIRES_IN_SECONDS'>): string {
  const payload: TokenPayload = { sub: String(user.id), role: user.role, username: user.username };
  return jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256', expiresIn: config.JWT_EXPIRES_IN_SECONDS });
}

/**
 * Verifies the Bearer token and loads the user from the database on every request,
 * so deactivation or a role change takes effect immediately.
 */
export function authenticate(pool: Pool, config: Pick<Config, 'JWT_SECRET'>): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
    if (!match || !match[1]) throw unauthenticated();

    let payload: jwt.JwtPayload;
    try {
      const decoded = jwt.verify(match[1], config.JWT_SECRET, { algorithms: ['HS256'] });
      if (typeof decoded === 'string') throw new Error('unexpected payload');
      payload = decoded;
    } catch {
      throw unauthenticated('Invalid or expired token');
    }

    const id = Number(payload.sub);
    if (!Number.isInteger(id)) throw unauthenticated('Invalid or expired token');

    const { rows } = await pool.query<{ id: number; username: string; full_name: string; role: Role }>(
      'SELECT id, username, full_name, role FROM users WHERE id = $1 AND is_active = true',
      [id],
    );
    const row = rows[0];
    if (!row) throw unauthenticated('Invalid or expired token');

    req.user = { id: row.id, username: row.username, fullName: row.full_name, role: row.role };
    next();
  };
}

/** Role guard. Must run after `authenticate`, and before body validation (see technical-spec §9). */
export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw unauthenticated();
    if (!allowed.includes(req.user.role)) throw forbidden();
    next();
  };
}

/** Returns the authenticated user or throws (for use inside route handlers). */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
