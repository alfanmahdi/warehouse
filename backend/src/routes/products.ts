import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { currentUser, requireRole } from '../http/auth.js';
import { booleanQuery, idParamSchema, paginationSchema, parse } from '../http/validate.js';
import {
  createProduct,
  getProduct,
  listProducts,
  productCreateSchema,
  productUpdateSchema,
  updateProduct,
} from '../services/products.js';

const listQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  active: booleanQuery.optional(),
});

export function productsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    res.json(await listProducts(pool, query));
  });

  router.get('/:id', async (req, res) => {
    res.json(await getProduct(pool, parse(idParamSchema, req.params.id)));
  });

  // Role is checked BEFORE the body is validated (technical-spec §9).
  router.post('/', requireRole('SUPERVISOR'), async (req, res) => {
    const input = parse(productCreateSchema, req.body);
    res.status(201).json(await createProduct(pool, currentUser(req).id, input));
  });

  router.patch('/:id', requireRole('SUPERVISOR'), async (req, res) => {
    const id = parse(idParamSchema, req.params.id);
    const input = parse(productUpdateSchema, req.body);
    res.json(await updateProduct(pool, id, input));
  });

  return router;
}
