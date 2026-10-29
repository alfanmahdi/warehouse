import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { paginationSchema, parse } from '../http/validate.js';
import { listInventory, listTransactions } from '../services/inventory.js';

const inventoryQuerySchema = paginationSchema.extend({ q: z.string().trim().max(100).optional() });

const transactionsQuerySchema = paginationSchema.extend({
  productId: z.coerce.number().int('Must be an integer').min(1).max(2_147_483_647).optional(),
});

export function inventoryRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listInventory(pool, parse(inventoryQuerySchema, req.query)));
  });

  // Declared before any "/:id" style route; the ledger is read-only through the API.
  router.get('/transactions', async (req, res) => {
    res.json(await listTransactions(pool, parse(transactionsQuerySchema, req.query)));
  });

  return router;
}
