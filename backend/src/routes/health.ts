import { Router } from 'express';
import type { Pool } from '../db.js';

export function healthRouter(pool: Pool): Router {
  const router = Router();

  /** Liveness: the process is up. */
  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: the database answers. Used by Docker health checks. */
  router.get('/ready', async (_req, res) => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'down' });
    }
  });

  return router;
}
