import { z } from 'zod';
import { isPgError, likePattern, type Queryable } from '../db.js';
import { AppError, notFound } from '../errors.js';
import type { Page } from '../http/validate.js';

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, sku, name, description, is_active, created_at, updated_at';

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  description: r.description,
  isActive: r.is_active,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

// ---- input schemas (BR-01, BR-02) -----------------------------------------------------------

/** SKU is trimmed and upper-cased by the server, then must match the stored format. */
export const skuSchema = z
  .string({ required_error: 'Required', invalid_type_error: 'Must be a string' })
  .transform((s) => s.trim().toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, 'Use 2–32 letters, digits, "-" or "_" (must start with a letter or digit)'),
  );

const nameSchema = z
  .string({ required_error: 'Required', invalid_type_error: 'Must be a string' })
  .transform((s) => s.trim())
  .pipe(z.string().min(1, 'Required').max(200, 'At most 200 characters'));

const descriptionSchema = z
  .string({ invalid_type_error: 'Must be a string' })
  .max(1000, 'At most 1000 characters')
  .nullable();

export const productCreateSchema = z
  .object({ sku: skuSchema, name: nameSchema, description: descriptionSchema.optional() })
  .strict();

/** `.strict()` rejects a `sku` field: the SKU is immutable (BR-01). */
export const productUpdateSchema = z
  .object({ name: nameSchema.optional(), description: descriptionSchema.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;

// ---- queries --------------------------------------------------------------------------------

export interface ProductListQuery {
  q?: string | undefined;
  active?: boolean | undefined;
  limit: number;
  offset: number;
}

export async function listProducts(db: Queryable, query: ProductListQuery): Promise<Page<Product>> {
  const pattern = query.q ? likePattern(query.q) : null;
  const where = `WHERE ($1::text IS NULL OR sku ILIKE $1 OR name ILIKE $1)
                   AND ($2::boolean IS NULL OR is_active = $2)`;
  const params = [pattern, query.active ?? null];

  const [rows, count] = await Promise.all([
    db.query<ProductRow>(`SELECT ${COLUMNS} FROM products ${where} ORDER BY sku LIMIT $3 OFFSET $4`, [
      ...params,
      query.limit,
      query.offset,
    ]),
    db.query<{ total: number }>(`SELECT count(*) AS total FROM products ${where}`, params),
  ]);
  return { data: rows.rows.map(toProduct), total: count.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
}

export async function getProduct(db: Queryable, id: number): Promise<Product> {
  const { rows } = await db.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Product');
  return toProduct(rows[0]);
}

export async function createProduct(db: Queryable, userId: number, input: ProductCreateInput): Promise<Product> {
  try {
    const { rows } = await db.query<ProductRow>(
      `INSERT INTO products (sku, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [input.sku, input.name, input.description ?? null, userId],
    );
    return toProduct(rows[0]!);
  } catch (err) {
    if (isPgError(err) && err.code === '23505' && err.constraint === 'products_sku_key') {
      throw new AppError(409, 'DUPLICATE_SKU', `A product with SKU ${input.sku} already exists`, { sku: input.sku });
    }
    throw err;
  }
}

export async function updateProduct(db: Queryable, id: number, input: ProductUpdateInput): Promise<Product> {
  const { rows } = await db.query<ProductRow>(
    `UPDATE products
        SET name        = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            is_active   = COALESCE($5, is_active),
            updated_at  = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, input.name ?? null, input.description !== undefined, input.description ?? null, input.isActive ?? null],
  );
  if (!rows[0]) throw notFound('Product');
  return toProduct(rows[0]);
}
