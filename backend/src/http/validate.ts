import { z } from 'zod';
import { validationError } from '../errors.js';

/** Parses `data` with `schema`; throws a 400 VALIDATION_ERROR with field-level details. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationError(
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Path id: digits only, 1..2,147,483,647 (rejects "abc", "1.5", "-1", "1e2", ""). */
export const idParamSchema = z
  .string()
  .regex(/^\d{1,10}$/, 'Must be a positive integer')
  .transform(Number)
  .refine((n) => n >= 1 && n <= 2_147_483_647, 'Must be a positive integer');

export const paginationSchema = z.object({
  limit: z.coerce.number().int('Must be an integer').min(1).max(100).default(20),
  offset: z.coerce.number().int('Must be an integer').min(0).default(0),
});

/** Optional boolean query param: "true" | "false". */
export const booleanQuery = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Whole-number quantity: 1..1,000,000. Strings, decimals, zero and negatives are rejected (no coercion). */
export const quantitySchema = z
  .number({ invalid_type_error: 'Must be a number', required_error: 'Required' })
  .int('Must be a whole number')
  .min(1, 'Must be at least 1')
  .max(1_000_000, 'Must be at most 1,000,000');

export const positiveIntSchema = z
  .number({ invalid_type_error: 'Must be a number', required_error: 'Required' })
  .int('Must be a whole number')
  .min(1, 'Must be at least 1')
  .max(2_147_483_647, 'Too large');

export interface Page<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}
