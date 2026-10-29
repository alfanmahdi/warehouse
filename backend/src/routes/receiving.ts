import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { currentUser, requireRole } from '../http/auth.js';
import { idParamSchema, paginationSchema, parse } from '../http/validate.js';
import { DOCUMENT_STATUSES } from '../services/documentStatus.js';
import {
  cancelDocument,
  completeDocument,
  createDocument,
  documentCreateSchema,
  getDocument,
  idempotencyKeySchema,
  listDocuments,
  receiptCreateSchema,
  recordReceipt,
} from '../services/receiving.js';

const listQuerySchema = paginationSchema.extend({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});

export function receivingRouter(pool: Pool): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await listDocuments(pool, parse(listQuerySchema, req.query)));
  });

  router.get('/:id', async (req, res) => {
    res.json(await getDocument(pool, parse(idParamSchema, req.params.id)));
  });

  // Any authenticated role (OPERATOR, SUPERVISOR) may create documents and record receipts.
  router.post('/', async (req, res) => {
    const input = parse(documentCreateSchema, req.body);
    res.status(201).json(await createDocument(pool, currentUser(req), input));
  });

  router.post('/:id/receipts', async (req, res) => {
    const id = parse(idParamSchema, req.params.id);
    const keyHeader = req.header('idempotency-key');
    const key = keyHeader === undefined ? undefined : parse(idempotencyKeySchema, keyHeader.trim());
    const input = parse(receiptCreateSchema, req.body);

    const result = await recordReceipt(pool, currentUser(req), id, input, key);
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(result.replayed ? 200 : 201).json({ receipt: result.receipt, document: result.document });
  });

  router.post('/:id/complete', requireRole('SUPERVISOR'), async (req, res) => {
    res.json(await completeDocument(pool, currentUser(req), parse(idParamSchema, req.params.id)));
  });

  router.post('/:id/cancel', requireRole('SUPERVISOR'), async (req, res) => {
    res.json(await cancelDocument(pool, currentUser(req), parse(idParamSchema, req.params.id)));
  });

  return router;
}
