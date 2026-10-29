import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isPgError } from '../db.js';
import { AppError, notFound } from '../errors.js';

export const notFoundHandler: RequestHandler = () => {
  throw notFound('Route');
};

/** Maps every error to the documented envelope `{ error: { code, message, details? } }`. */
export const errorHandler = (log: (msg: string, err?: unknown) => void): ErrorRequestHandler => {
  return (err, _req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) {
      return void res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) } });
    }

    if (err instanceof ZodError) {
      return void res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }

    // body-parser errors (malformed JSON, payload too large, ...)
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      return void res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    }
    if (e?.type === 'entity.too.large') {
      return void res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body too large' } });
    }

    // Last line of defence: database constraints caught what application code missed.
    if (isPgError(err)) {
      if (err.code === '23505' && err.constraint === 'products_sku_key') {
        return void res.status(409).json({ error: { code: 'DUPLICATE_SKU', message: 'A product with this SKU already exists' } });
      }
      if (err.code === '23514' && err.constraint === 'receiving_items_received_within_expected') {
        log('DB CHECK prevented an over-receipt that application code let through', err);
        return void res.status(422).json({ error: { code: 'OVER_RECEIPT', message: 'Quantity exceeds the remaining expected quantity' } });
      }
    }

    log('Unhandled error', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  };
};
