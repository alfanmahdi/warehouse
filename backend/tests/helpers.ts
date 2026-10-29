import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { TEST_DATABASE_URL } from './globalSetup.js';

export const config: Config = loadConfig({
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-test-secret-test-secret-123',
  BCRYPT_ROUNDS: '4',
  LOG_REQUESTS: 'false',
});

export const PASSWORD = 'correct-horse-battery';

export const pool: Pool = createPool(TEST_DATABASE_URL);
export const app = createApp({ pool, config, log: () => undefined });

export type RoleName = 'operator' | 'supervisor';
const tokens = new Map<RoleName, string>();

/** Creates the two demo users (if needed) and returns a token for the requested role. */
export async function tokenFor(role: RoleName): Promise<string> {
  const cached = tokens.get(role);
  if (cached) return cached;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await pool.query(
    `INSERT INTO users (username, full_name, password_hash, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO NOTHING`,
    [role, role === 'operator' ? 'Test Operator' : 'Test Supervisor', hash, role.toUpperCase()],
  );
  const res = await request(app).post('/api/auth/login').send({ username: role, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed in test helper: ${res.status} ${JSON.stringify(res.body)}`);
  tokens.set(role, res.body.token);
  return res.body.token;
}

export const auth = async (role: RoleName) => ({ Authorization: `Bearer ${await tokenFor(role)}` });

/** Signs a token like the server would (for expired / foreign-secret tests). */
export function forgeToken(sub: number, role: string, opts: { secret?: string; expiresIn?: number } = {}): string {
  return jwt.sign({ sub: String(sub), role, username: 'x' }, opts.secret ?? config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: opts.expiresIn ?? 3600,
  });
}

let counter = 0;
/** Unique, valid SKU per call so tests never collide on the shared database. */
export const uniqueSku = (prefix = 'T') =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`.toUpperCase();

export interface ProductDto {
  id: number;
  sku: string;
  name: string;
  isActive: boolean;
}

export async function createProduct(name = 'Test product', sku = uniqueSku()): Promise<ProductDto> {
  const res = await request(app).post('/api/products').set(await auth('supervisor')).send({ sku, name });
  if (res.status !== 201) throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export interface ItemDto {
  id: number;
  productId: number;
  sku: string;
  expectedQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
}
export interface DocDto {
  id: number;
  documentNumber: string;
  status: string;
  items: ItemDto[];
  receipts: Array<{ id: number; lines: Array<{ itemId: number; quantity: number; balanceAfter: number }> }>;
  totalExpected: number;
  totalReceived: number;
}

/** Creates a product per entry and a document expecting the given quantities. */
export async function createDocument(expected: number[], role: RoleName = 'operator'): Promise<{ doc: DocDto; products: ProductDto[] }> {
  const products = await Promise.all(expected.map((_, i) => createProduct(`Product ${i}`)));
  const res = await request(app)
    .post('/api/receiving-documents')
    .set(await auth(role))
    .send({
      supplierName: 'ACME Supplies',
      referenceNumber: 'PO-1',
      items: products.map((p, i) => ({ productId: p.id, expectedQuantity: expected[i] })),
    });
  if (res.status !== 201) throw new Error(`createDocument failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { doc: res.body, products };
}

export async function receive(
  docId: number,
  lines: Array<{ itemId: number; quantity: unknown }>,
  opts: { role?: RoleName; key?: string } = {},
) {
  const req = request(app)
    .post(`/api/receiving-documents/${docId}/receipts`)
    .set(await auth(opts.role ?? 'operator'));
  if (opts.key !== undefined) req.set('Idempotency-Key', opts.key);
  return req.send({ lines });
}

export const getDoc = async (id: number): Promise<DocDto> =>
  (await request(app).get(`/api/receiving-documents/${id}`).set(await auth('operator'))).body;

export async function onHand(productId: number): Promise<number> {
  const { rows } = await pool.query<{ q: number }>('SELECT quantity_on_hand AS q FROM inventory WHERE product_id = $1', [productId]);
  return rows[0]?.q ?? 0;
}

export async function ledgerRows(productId: number) {
  const { rows } = await pool.query<{ quantity_change: number; balance_after: number }>(
    'SELECT quantity_change, balance_after FROM inventory_transactions WHERE product_id = $1 ORDER BY id',
    [productId],
  );
  return rows;
}

/** BR-14: returns every product whose on-hand differs from the sum of its ledger (must be empty). */
export async function driftedProducts() {
  const { rows } = await pool.query(
    `SELECT i.product_id, i.quantity_on_hand, COALESCE(s.total, 0) AS ledger_total
       FROM inventory i
       LEFT JOIN (SELECT product_id, sum(quantity_change) AS total FROM inventory_transactions GROUP BY product_id) s
         ON s.product_id = i.product_id
      WHERE i.quantity_on_hand <> COALESCE(s.total, 0)
     UNION ALL
     SELECT s.product_id, 0, s.total
       FROM (SELECT product_id, sum(quantity_change) AS total FROM inventory_transactions GROUP BY product_id) s
       LEFT JOIN inventory i ON i.product_id = s.product_id
      WHERE i.product_id IS NULL`,
  );
  return rows;
}

/** Rows violating received <= expected anywhere in the database (must be empty). */
export async function overReceivedItems() {
  const { rows } = await pool.query(
    'SELECT id FROM receiving_items WHERE received_quantity > expected_quantity OR received_quantity < 0',
  );
  return rows;
}

export { request };
