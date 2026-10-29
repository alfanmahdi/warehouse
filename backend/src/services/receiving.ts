/**
 * Receiving documents and the receiving workflow.
 *
 * `recordReceipt()` is the ONLY place that changes received quantities, inventory and the ledger.
 * It implements BR-06..BR-09, BR-13, BR-14 inside ONE transaction using this lock order
 * (technical-spec §7): document row → item rows (by product_id) → inventory rows (ascending product_id).
 */
import { z } from 'zod';
import { isPgError, likePattern, withTransaction, type Pool, type PoolClient, type Queryable } from '../db.js';
import { AppError, invalidState, notFound } from '../errors.js';
import type { AuthUser } from '../http/auth.js';
import { positiveIntSchema, quantitySchema, type Page } from '../http/validate.js';
import {
  deriveReceivingStatus,
  isActionAllowed,
  isTerminal,
  type DocumentStatus,
} from './documentStatus.js';

// ---------------------------------------------------------------------------------------------
// Input schemas (BR-04, BR-05, BR-06; field rules in PRD §5.2)
// ---------------------------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string({ invalid_type_error: 'Must be a string' })
    .max(max, `At most ${max} characters`)
    .transform((s) => s.trim())
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

const calendarDate = z
  .string({ invalid_type_error: 'Must be a string' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a valid calendar date')
  .nullable()
  .optional();

export const documentCreateSchema = z
  .object({
    supplierName: z
      .string({ required_error: 'Required', invalid_type_error: 'Must be a string' })
      .transform((s) => s.trim())
      .pipe(z.string().min(1, 'Required').max(200, 'At most 200 characters')),
    referenceNumber: optionalText(100),
    expectedDate: calendarDate,
    notes: optionalText(1000),
    items: z
      .array(
        z
          .object({ productId: positiveIntSchema, expectedQuantity: quantitySchema })
          .strict(),
        { required_error: 'Required', invalid_type_error: 'Must be an array' },
      )
      .min(1, 'A document needs at least one item')
      .max(100, 'A document can have at most 100 items'),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<number>();
    doc.items.forEach((item, index) => {
      if (seen.has(item.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'productId'],
          message: 'Each product can appear only once per document',
        });
      }
      seen.add(item.productId);
    });
  });
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;

export const receiptCreateSchema = z
  .object({
    lines: z
      .array(z.object({ itemId: positiveIntSchema, quantity: quantitySchema }).strict(), {
        required_error: 'Required',
        invalid_type_error: 'Must be an array',
      })
      .min(1, 'At least one line is required')
      .max(100, 'At most 100 lines'),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<number>();
    r.lines.forEach((line, index) => {
      if (seen.has(line.itemId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lines', index, 'itemId'],
          message: 'Each item can appear only once per receipt',
        });
      }
      seen.add(line.itemId);
    });
  });
export type ReceiptCreateInput = z.infer<typeof receiptCreateSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(1, 'Idempotency-Key must not be empty')
  .max(128, 'Idempotency-Key must be at most 128 characters')
  .regex(/^[\x21-\x7E]+$/, 'Idempotency-Key must contain printable ASCII characters only');

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export interface UserRef {
  id: number;
  fullName: string;
}

export interface DocumentSummary {
  id: number;
  documentNumber: string;
  supplierName: string;
  referenceNumber: string | null;
  expectedDate: string | null;
  status: DocumentStatus;
  itemCount: number;
  totalExpected: number;
  totalReceived: number;
  createdAt: string;
}

export interface DocumentItem {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  expectedQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
}

export interface ReceiptLine {
  itemId: number;
  productId: number;
  sku: string;
  quantity: number;
  balanceAfter: number;
}

export interface Receipt {
  id: number;
  receivedBy: UserRef;
  createdAt: string;
  lines: ReceiptLine[];
}

export interface ReceivingDocument extends DocumentSummary {
  notes: string | null;
  createdBy: UserRef;
  completedAt: string | null;
  completedBy: UserRef | null;
  cancelledAt: string | null;
  cancelledBy: UserRef | null;
  items: DocumentItem[];
  receipts: Receipt[];
}

export interface ReceiptResult {
  /** true when an Idempotency-Key matched a previous receipt: the original is returned, nothing changed (BR-13). */
  replayed: boolean;
  receipt: Receipt;
  document: ReceivingDocument;
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface DocumentListQuery {
  status?: DocumentStatus | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

interface SummaryRow {
  id: number;
  document_number: string;
  supplier_name: string;
  reference_number: string | null;
  expected_date: string | null;
  status: DocumentStatus;
  created_at: Date;
  item_count: number;
  total_expected: number;
  total_received: number;
}

const toSummary = (r: SummaryRow): DocumentSummary => ({
  id: r.id,
  documentNumber: r.document_number,
  supplierName: r.supplier_name,
  referenceNumber: r.reference_number,
  expectedDate: r.expected_date,
  status: r.status,
  itemCount: r.item_count,
  totalExpected: r.total_expected,
  totalReceived: r.total_received,
  createdAt: r.created_at.toISOString(),
});

export async function listDocuments(db: Queryable, query: DocumentListQuery): Promise<Page<DocumentSummary>> {
  const pattern = query.q ? likePattern(query.q) : null;
  const where = `WHERE ($1::text IS NULL OR d.status = $1)
                   AND ($2::text IS NULL OR d.document_number ILIKE $2 OR d.supplier_name ILIKE $2 OR d.reference_number ILIKE $2)`;
  const params = [query.status ?? null, pattern];

  const [rows, count] = await Promise.all([
    db.query<SummaryRow>(
      `SELECT d.id, d.document_number, d.supplier_name, d.reference_number, d.expected_date, d.status, d.created_at,
              COALESCE(s.item_count, 0)     AS item_count,
              COALESCE(s.total_expected, 0) AS total_expected,
              COALESCE(s.total_received, 0) AS total_received
         FROM receiving_documents d
         LEFT JOIN LATERAL (
              SELECT count(*)::int AS item_count,
                     sum(expected_quantity)::bigint AS total_expected,
                     sum(received_quantity)::bigint AS total_received
                FROM receiving_items WHERE document_id = d.id) s ON true
        ${where}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $3 OFFSET $4`,
      [...params, query.limit, query.offset],
    ),
    db.query<{ total: number }>(`SELECT count(*) AS total FROM receiving_documents d ${where}`, params),
  ]);
  return { data: rows.rows.map(toSummary), total: count.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
}

export async function getDocument(db: Queryable, id: number): Promise<ReceivingDocument> {
  const docRes = await db.query<
    Omit<SummaryRow, 'item_count' | 'total_expected' | 'total_received'> & {
      notes: string | null;
      created_by: number;
      created_by_name: string;
      completed_at: Date | null;
      completed_by: number | null;
      completed_by_name: string | null;
      cancelled_at: Date | null;
      cancelled_by: number | null;
      cancelled_by_name: string | null;
    }
  >(
    `SELECT d.id, d.document_number, d.supplier_name, d.reference_number, d.expected_date, d.notes, d.status, d.created_at,
            d.created_by, cu.full_name AS created_by_name,
            d.completed_at, d.completed_by, xu.full_name AS completed_by_name,
            d.cancelled_at, d.cancelled_by, nu.full_name AS cancelled_by_name
       FROM receiving_documents d
       JOIN users cu ON cu.id = d.created_by
       LEFT JOIN users xu ON xu.id = d.completed_by
       LEFT JOIN users nu ON nu.id = d.cancelled_by
      WHERE d.id = $1`,
    [id],
  );
  const d = docRes.rows[0];
  if (!d) throw notFound('Receiving document');

  const itemsRes = await db.query<{
    id: number;
    product_id: number;
    sku: string;
    name: string;
    expected_quantity: number;
    received_quantity: number;
  }>(
    `SELECT i.id, i.product_id, p.sku, p.name, i.expected_quantity, i.received_quantity
       FROM receiving_items i JOIN products p ON p.id = i.product_id
      WHERE i.document_id = $1 ORDER BY i.id`,
    [id],
  );
  const items: DocumentItem[] = itemsRes.rows.map((i) => ({
    id: i.id,
    productId: i.product_id,
    sku: i.sku,
    productName: i.name,
    expectedQuantity: i.expected_quantity,
    receivedQuantity: i.received_quantity,
    remainingQuantity: i.expected_quantity - i.received_quantity,
  }));

  const receiptsRes = await db.query<{ id: number; created_at: Date; user_id: number; full_name: string }>(
    `SELECT r.id, r.created_at, u.id AS user_id, u.full_name
       FROM receipts r JOIN users u ON u.id = r.received_by
      WHERE r.document_id = $1 ORDER BY r.id`,
    [id],
  );
  const receiptIds = receiptsRes.rows.map((r) => r.id);
  const linesRes = receiptIds.length
    ? await db.query<{
        receipt_id: number;
        item_id: number;
        product_id: number;
        sku: string;
        quantity: number;
        balance_after: number;
      }>(
        `SELECT t.receipt_id, t.receiving_item_id AS item_id, t.product_id, p.sku,
                t.quantity_change AS quantity, t.balance_after
           FROM inventory_transactions t JOIN products p ON p.id = t.product_id
          WHERE t.receipt_id = ANY($1::int[]) ORDER BY t.id`,
        [receiptIds],
      )
    : { rows: [] };

  const receipts: Receipt[] = receiptsRes.rows.map((r) => ({
    id: r.id,
    receivedBy: { id: r.user_id, fullName: r.full_name },
    createdAt: r.created_at.toISOString(),
    lines: linesRes.rows
      .filter((l) => l.receipt_id === r.id)
      .map((l) => ({
        itemId: l.item_id,
        productId: l.product_id,
        sku: l.sku,
        quantity: l.quantity,
        balanceAfter: l.balance_after,
      })),
  }));

  return {
    ...toSummary({
      ...d,
      item_count: items.length,
      total_expected: items.reduce((n, i) => n + i.expectedQuantity, 0),
      total_received: items.reduce((n, i) => n + i.receivedQuantity, 0),
    }),
    notes: d.notes,
    createdBy: { id: d.created_by, fullName: d.created_by_name },
    completedAt: d.completed_at?.toISOString() ?? null,
    completedBy: d.completed_by !== null ? { id: d.completed_by, fullName: d.completed_by_name ?? '' } : null,
    cancelledAt: d.cancelled_at?.toISOString() ?? null,
    cancelledBy: d.cancelled_by !== null ? { id: d.cancelled_by, fullName: d.cancelled_by_name ?? '' } : null,
    items,
    receipts,
  };
}

// ---------------------------------------------------------------------------------------------
// Create (BR-03, BR-04, BR-05)
// ---------------------------------------------------------------------------------------------

export async function createDocument(pool: Pool, user: AuthUser, input: DocumentCreateInput): Promise<ReceivingDocument> {
  return withTransaction(pool, async (c) => {
    const productIds = input.items.map((i) => i.productId);

    // FOR SHARE: a product cannot be deactivated by a concurrent request while we add it to a document.
    const { rows: products } = await c.query<{ id: number; sku: string; is_active: boolean }>(
      'SELECT id, sku, is_active FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE',
      [productIds],
    );
    const byId = new Map(products.map((p) => [p.id, p]));

    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new AppError(422, 'PRODUCT_NOT_FOUND', `Unknown product id(s): ${missing.join(', ')}`, { productIds: missing });
    }
    const inactive = products.filter((p) => !p.is_active).map((p) => p.sku);
    if (inactive.length) {
      throw new AppError(422, 'PRODUCT_INACTIVE', `Inactive product(s) cannot be added: ${inactive.join(', ')}`, {
        skus: inactive,
      });
    }

    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO receiving_documents (supplier_name, reference_number, expected_date, notes, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.supplierName, input.referenceNumber ?? null, input.expectedDate ?? null, input.notes ?? null, user.id],
    );
    const documentId = rows[0]!.id;

    await c.query(
      `INSERT INTO receiving_items (document_id, product_id, expected_quantity)
       SELECT $1, t.product_id, t.qty FROM unnest($2::int[], $3::int[]) AS t(product_id, qty)`,
      [documentId, productIds, input.items.map((i) => i.expectedQuantity)],
    );

    return getDocument(c, documentId);
  });
}

// ---------------------------------------------------------------------------------------------
// Record a receipt (BR-06 .. BR-09, BR-13, BR-14)
// ---------------------------------------------------------------------------------------------

interface LockedItem {
  id: number;
  product_id: number;
  sku: string;
  expected_quantity: number;
  received_quantity: number;
}

function sameLines(
  prior: ReadonlyArray<{ itemId: number; quantity: number }>,
  requested: ReadonlyArray<{ itemId: number; quantity: number }>,
): boolean {
  if (prior.length !== requested.length) return false;
  const priorMap = new Map(prior.map((l) => [l.itemId, l.quantity]));
  return requested.every((l) => priorMap.get(l.itemId) === l.quantity);
}

export async function recordReceipt(
  pool: Pool,
  user: AuthUser,
  documentId: number,
  input: ReceiptCreateInput,
  idempotencyKey?: string,
): Promise<ReceiptResult> {
  return withTransaction(pool, async (c) => {
    // 1. Lock the document row. All receipts / completions / cancellations of this document are serialised here.
    const docRes = await c.query<{ id: number; status: DocumentStatus }>(
      'SELECT id, status FROM receiving_documents WHERE id = $1 FOR UPDATE',
      [documentId],
    );
    const doc = docRes.rows[0];
    if (!doc) throw notFound('Receiving document');

    // 2. Idempotency (BR-13). Checked BEFORE the status check so a replay of the receipt that made the
    //    document FULLY_RECEIVED still returns the original result instead of INVALID_STATE.
    if (idempotencyKey !== undefined) {
      const prior = await c.query<{ id: number; document_id: number }>(
        'SELECT id, document_id FROM receipts WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing) {
        const reused = (message: string) => new AppError(409, 'IDEMPOTENCY_KEY_REUSED', message);
        if (existing.document_id !== documentId) {
          throw reused('This Idempotency-Key was already used for a different document');
        }
        const document = await getDocument(c, documentId);
        const receipt = document.receipts.find((r) => r.id === existing.id)!;
        if (!sameLines(receipt.lines, input.lines)) {
          throw reused('This Idempotency-Key was already used with different lines');
        }
        return { replayed: true, receipt, document };
      }
    }

    // 3. Status gate (BR-07 / BR-12)
    if (!isActionAllowed(doc.status, 'RECEIPT')) {
      throw invalidState(
        `Cannot record a receipt: document is ${doc.status}. Receipts are only accepted while OPEN or PARTIALLY_RECEIVED.`,
        { status: doc.status },
      );
    }

    // 4. Lock every item row of this document in a stable order.
    const itemsRes = await c.query<LockedItem>(
      `SELECT i.id, i.product_id, p.sku, i.expected_quantity, i.received_quantity
         FROM receiving_items i JOIN products p ON p.id = i.product_id
        WHERE i.document_id = $1
        ORDER BY i.product_id
        FOR UPDATE OF i`,
      [documentId],
    );
    const items = new Map(itemsRes.rows.map((i) => [i.id, i]));

    // 5. Validate EVERY line before writing anything (BR-06, BR-08). Order of lines = order of the request.
    for (const line of input.lines) {
      const item = items.get(line.itemId);
      if (!item) {
        const elsewhere = await c.query('SELECT 1 FROM receiving_items WHERE id = $1', [line.itemId]);
        if (elsewhere.rowCount) {
          throw new AppError(422, 'ITEM_NOT_IN_DOCUMENT', `Item ${line.itemId} does not belong to this document`, {
            itemId: line.itemId,
          });
        }
        throw notFound(`Receiving item ${line.itemId}`);
      }
      const remaining = item.expected_quantity - item.received_quantity;
      if (line.quantity > remaining) {
        throw new AppError(
          422,
          'OVER_RECEIPT',
          `Cannot receive ${line.quantity} of ${item.sku}: only ${remaining} remaining.`,
          { itemId: item.id, sku: item.sku, requested: line.quantity, remaining },
        );
      }
    }

    // 6. Apply. Ascending product_id => consistent lock order across concurrent receipts (no deadlocks).
    let receiptId: number;
    try {
      const r = await c.query<{ id: number }>(
        'INSERT INTO receipts (document_id, received_by, idempotency_key) VALUES ($1, $2, $3) RETURNING id',
        [documentId, user.id, idempotencyKey ?? null],
      );
      receiptId = r.rows[0]!.id;
    } catch (err) {
      // Same key used concurrently for a different document: loser of the race lands here.
      if (isPgError(err) && err.code === '23505' && err.constraint === 'receipts_idempotency_key_key') {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different document');
      }
      throw err;
    }

    const ordered = [...input.lines].sort((a, b) => items.get(a.itemId)!.product_id - items.get(b.itemId)!.product_id);
    for (const line of ordered) {
      await applyLine(c, user.id, receiptId, items.get(line.itemId)!, line.quantity);
    }

    // 7. Derive the new status from item data (BR-15).
    const after = await c.query<{ expected_quantity: number; received_quantity: number }>(
      'SELECT expected_quantity, received_quantity FROM receiving_items WHERE document_id = $1',
      [documentId],
    );
    const status = deriveReceivingStatus(
      after.rows.map((i) => ({ expectedQuantity: i.expected_quantity, receivedQuantity: i.received_quantity })),
    );
    await c.query('UPDATE receiving_documents SET status = $2, updated_at = now() WHERE id = $1', [documentId, status]);

    const document = await getDocument(c, documentId);
    const receipt = document.receipts.find((r) => r.id === receiptId)!;
    return { replayed: false, receipt, document };
  });
}

/** One receipt line: item quantity, inventory on-hand, ledger entry. Same transaction as the caller (BR-09). */
async function applyLine(c: PoolClient, userId: number, receiptId: number, item: LockedItem, quantity: number): Promise<void> {
  // The CHECK (received_quantity <= expected_quantity) is a second line of defence behind step 5.
  await c.query('UPDATE receiving_items SET received_quantity = received_quantity + $2 WHERE id = $1', [item.id, quantity]);

  const inv = await c.query<{ quantity_on_hand: number }>(
    `INSERT INTO inventory (product_id, quantity_on_hand) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE
        SET quantity_on_hand = inventory.quantity_on_hand + EXCLUDED.quantity_on_hand, updated_at = now()
     RETURNING quantity_on_hand`,
    [item.product_id, quantity],
  );

  await c.query(
    `INSERT INTO inventory_transactions
        (product_id, type, quantity_change, balance_after, receipt_id, receiving_item_id, created_by)
     VALUES ($1, 'RECEIPT', $2, $3, $4, $5, $6)`,
    [item.product_id, quantity, inv.rows[0]!.quantity_on_hand, receiptId, item.id, userId],
  );
}

// ---------------------------------------------------------------------------------------------
// Complete / Cancel (BR-10, BR-11, BR-12)
// ---------------------------------------------------------------------------------------------

export async function completeDocument(pool: Pool, user: AuthUser, documentId: number): Promise<ReceivingDocument> {
  return withTransaction(pool, async (c) => {
    const docRes = await c.query<{ status: DocumentStatus }>(
      'SELECT status FROM receiving_documents WHERE id = $1 FOR UPDATE',
      [documentId],
    );
    const doc = docRes.rows[0];
    if (!doc) throw notFound('Receiving document');

    if (isTerminal(doc.status)) {
      throw invalidState(`Document is already ${doc.status}`, { status: doc.status });
    }

    // BR-10: verify against the item data itself, not just the cached status.
    const open = await c.query<{ id: number; sku: string; expected_quantity: number; received_quantity: number }>(
      `SELECT i.id, p.sku, i.expected_quantity, i.received_quantity
         FROM receiving_items i JOIN products p ON p.id = i.product_id
        WHERE i.document_id = $1 AND i.received_quantity < i.expected_quantity
        ORDER BY i.id`,
      [documentId],
    );
    if (open.rowCount) {
      throw new AppError(
        422,
        'NOT_FULLY_RECEIVED',
        `Cannot complete: ${open.rowCount} item(s) are not fully received.`,
        {
          openItems: open.rows.map((i) => ({
            itemId: i.id,
            sku: i.sku,
            expected: i.expected_quantity,
            received: i.received_quantity,
            remaining: i.expected_quantity - i.received_quantity,
          })),
        },
      );
    }

    if (!isActionAllowed(doc.status, 'COMPLETE')) {
      throw invalidState(`Cannot complete a document that is ${doc.status}`, { status: doc.status });
    }

    await c.query(
      `UPDATE receiving_documents
          SET status = 'COMPLETED', completed_by = $2, completed_at = now(), updated_at = now()
        WHERE id = $1`,
      [documentId, user.id],
    );
    return getDocument(c, documentId);
  });
}

export async function cancelDocument(pool: Pool, user: AuthUser, documentId: number): Promise<ReceivingDocument> {
  return withTransaction(pool, async (c) => {
    const docRes = await c.query<{ status: DocumentStatus }>(
      'SELECT status FROM receiving_documents WHERE id = $1 FOR UPDATE',
      [documentId],
    );
    const doc = docRes.rows[0];
    if (!doc) throw notFound('Receiving document');

    if (!isActionAllowed(doc.status, 'CANCEL')) {
      throw invalidState(
        `Cannot cancel a document that is ${doc.status}. Only OPEN documents (nothing received yet) can be cancelled.`,
        { status: doc.status },
      );
    }
    // Defensive (BR-11): status says OPEN, so nothing should be received. Verify against item data anyway.
    const received = await c.query('SELECT 1 FROM receiving_items WHERE document_id = $1 AND received_quantity > 0 LIMIT 1', [
      documentId,
    ]);
    if (received.rowCount) {
      throw invalidState('Cannot cancel a document that already has received quantities');
    }

    await c.query(
      `UPDATE receiving_documents
          SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), updated_at = now()
        WHERE id = $1`,
      [documentId, user.id],
    );
    return getDocument(c, documentId);
  });
}
