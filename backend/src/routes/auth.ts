import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db.js';
import { authenticate, currentUser } from '../http/auth.js';
import { parse } from '../http/validate.js';
import { login } from '../services/auth.js';

const loginSchema = z
  .object({
    username: z.string({ required_error: 'Required', invalid_type_error: 'Must be a string' }).min(1, 'Required').max(50),
    password: z.string({ required_error: 'Required', invalid_type_error: 'Must be a string' }).min(1, 'Required').max(200),
  })
  .strict();

export function authRouter(pool: Pool, config: Config): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const body = parse(loginSchema, req.body);
    res.json(await login(pool, config, body.username, body.password));
  });

  router.get('/me', authenticate(pool, config), (req, res) => {
    res.json({ user: currentUser(req) });
  });

  return router;
}
