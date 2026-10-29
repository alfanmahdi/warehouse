import { likePattern, type Queryable } from '../db.js';
import type { Page } from '../http/validate.js';

export interface InventoryItem {
  productId: number;
  sku: string;
  name: string;
  isActive: boolean;
  quantityOnHand: number;
  updatedAt: string | null;
}

export interface InventoryTransaction {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  type: 'RECEIPT';
  quantityChange: number;
  balanceAfter: number;
  documentId: number;
  documentNumber: string;
  receiptId: number;
  createdBy: { id: number; fullName: string };
  createdAt: string;
}

/** FR-INV-1: one row per product, including products that were never received (quantity 0). */
export async function listInventory(
  db: Queryable,
  query: { q?: string | undefined; limit: number; offset: number },
): Promise<Page<InventoryItem>> {
  const pattern = query.q ? likePattern(query.q) : null;
  const where = 'WHERE ($1::text IS NULL OR p.sku ILIKE $1 OR p.name ILIKE $1)';

  const [rows, count] = await Promise.all([
    db.query<{
      product_id: number;
      sku: string;
      name: string;
      is_active: boolean;
      quantity_on_hand: number;
      updated_at: Date | null;
    }>(
      `SELECT p.id AS product_id, p.sku, p.name, p.is_active,
              COALESCE(i.quantity_on_hand, 0) AS quantity_on_hand, i.updated_at
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id
        ${where}
        ORDER BY p.sku
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset],
    ),
    db.query<{ total: number }>(`SELECT count(*) AS total FROM products p ${where}`, [pattern]),
  ]);

  return {
    data: rows.rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      isActive: r.is_active,
      quantityOnHand: r.quantity_on_hand,
      updatedAt: r.updated_at?.toISOString() ?? null,
    })),
    total: count.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}

/** FR-INV-2: the ledger, newest first, optionally for one product. */
export async function listTransactions(
  db: Queryable,
  query: { productId?: number | undefined; limit: number; offset: number },
): Promise<Page<InventoryTransaction>> {
  const where = 'WHERE ($1::int IS NULL OR t.product_id = $1)';
  const productId = query.productId ?? null;

  const [rows, count] = await Promise.all([
    db.query<{
      id: number;
      product_id: number;
      sku: string;
      product_name: string;
      type: 'RECEIPT';
      quantity_change: number;
      balance_after: number;
      document_id: number;
      document_number: string;
      receipt_id: number;
      user_id: number;
      full_name: string;
      created_at: Date;
    }>(
      `SELECT t.id, t.product_id, p.sku, p.name AS product_name, t.type, t.quantity_change, t.balance_after,
              d.id AS document_id, d.document_number, t.receipt_id, u.id AS user_id, u.full_name, t.created_at
         FROM inventory_transactions t
         JOIN products p ON p.id = t.product_id
         JOIN receipts r ON r.id = t.receipt_id
         JOIN receiving_documents d ON d.id = r.document_id
         JOIN users u ON u.id = t.created_by
        ${where}
        ORDER BY t.id DESC
        LIMIT $2 OFFSET $3`,
      [productId, query.limit, query.offset],
    ),
    db.query<{ total: number }>(`SELECT count(*) AS total FROM inventory_transactions t ${where}`, [productId]),
  ]);

  return {
    data: rows.rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      type: r.type,
      quantityChange: r.quantity_change,
      balanceAfter: r.balance_after,
      documentId: r.document_id,
      documentNumber: r.document_number,
      receiptId: r.receipt_id,
      createdBy: { id: r.user_id, fullName: r.full_name },
      createdAt: r.created_at.toISOString(),
    })),
    total: count.rows[0]?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
  };
}
