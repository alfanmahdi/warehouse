import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { likePattern } from '../src/db.js';
import {
  DOCUMENT_STATUSES,
  deriveReceivingStatus,
  isActionAllowed,
  isTerminal,
  isTransitionAllowed,
  type DocumentAction,
} from '../src/services/documentStatus.js';
import { productCreateSchema, productUpdateSchema } from '../src/services/products.js';
import { documentCreateSchema, idempotencyKeySchema, receiptCreateSchema } from '../src/services/receiving.js';

const messages = (r: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  r.error?.issues.map((i) => i.message) ?? [];

describe('document status model (BR-07, BR-10..12, BR-15)', () => {
  const actions: DocumentAction[] = ['RECEIPT', 'COMPLETE', 'CANCEL'];
  // expected[status] = actions allowed
  const expected: Record<string, DocumentAction[]> = {
    OPEN: ['RECEIPT', 'CANCEL'],
    PARTIALLY_RECEIVED: ['RECEIPT'],
    FULLY_RECEIVED: ['COMPLETE'],
    COMPLETED: [],
    CANCELLED: [],
  };

  for (const status of DOCUMENT_STATUSES) {
    for (const action of actions) {
      const allowed = expected[status]!.includes(action);
      it(`${status} + ${action} → ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(isActionAllowed(status, action)).toBe(allowed);
      });
    }
  }

  it('terminal statuses allow no transition at all (BR-12)', () => {
    for (const from of ['COMPLETED', 'CANCELLED'] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of DOCUMENT_STATUSES) expect(isTransitionAllowed(from, to)).toBe(false);
    }
  });

  it('only the documented transitions exist', () => {
    const allowed: Array<[string, string]> = [
      ['OPEN', 'PARTIALLY_RECEIVED'],
      ['OPEN', 'FULLY_RECEIVED'],
      ['OPEN', 'CANCELLED'],
      ['PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED'],
      ['PARTIALLY_RECEIVED', 'FULLY_RECEIVED'],
      ['FULLY_RECEIVED', 'COMPLETED'],
    ];
    for (const from of DOCUMENT_STATUSES) {
      for (const to of DOCUMENT_STATUSES) {
        const isAllowed = allowed.some(([f, t]) => f === from && t === to);
        expect(isTransitionAllowed(from, to), `${from} → ${to}`).toBe(isAllowed);
      }
    }
  });

  it('cannot jump from PARTIALLY_RECEIVED straight to COMPLETED or CANCELLED', () => {
    expect(isTransitionAllowed('PARTIALLY_RECEIVED', 'COMPLETED')).toBe(false);
    expect(isTransitionAllowed('PARTIALLY_RECEIVED', 'CANCELLED')).toBe(false);
    expect(isTransitionAllowed('OPEN', 'COMPLETED')).toBe(false);
  });

  it('derives status from item quantities (BR-15)', () => {
    expect(deriveReceivingStatus([{ expectedQuantity: 5, receivedQuantity: 0 }])).toBe('OPEN');
    expect(deriveReceivingStatus([{ expectedQuantity: 5, receivedQuantity: 1 }])).toBe('PARTIALLY_RECEIVED');
    expect(deriveReceivingStatus([{ expectedQuantity: 5, receivedQuantity: 5 }])).toBe('FULLY_RECEIVED');
    expect(
      deriveReceivingStatus([
        { expectedQuantity: 5, receivedQuantity: 5 },
        { expectedQuantity: 2, receivedQuantity: 0 },
      ]),
    ).toBe('PARTIALLY_RECEIVED');
    expect(
      deriveReceivingStatus([
        { expectedQuantity: 5, receivedQuantity: 5 },
        { expectedQuantity: 2, receivedQuantity: 2 },
      ]),
    ).toBe('FULLY_RECEIVED');
  });
});

describe('SKU and product validation (BR-01, BR-02)', () => {
  const ok = (sku: string) => productCreateSchema.safeParse({ sku, name: 'x' });

  it('trims and upper-cases the SKU', () => {
    const r = productCreateSchema.parse({ sku: '  abc-1_x ', name: ' Widget ' });
    expect(r.sku).toBe('ABC-1_X');
    expect(r.name).toBe('Widget');
  });

  it.each(['', ' ', 'a', 'a b', '-abc', '_abc', 'ab$', 'ab.c', 'x'.repeat(33), 'ünï'])('rejects invalid SKU %j', (sku) => {
    expect(ok(sku).success).toBe(false);
  });

  it.each(['AB', 'a1', '1A', 'WIDGET-001', 'x'.repeat(32)])('accepts valid SKU %j', (sku) => {
    expect(ok(sku).success).toBe(true);
  });

  it('requires a non-blank name of at most 200 characters', () => {
    expect(productCreateSchema.safeParse({ sku: 'AB', name: '   ' }).success).toBe(false);
    expect(productCreateSchema.safeParse({ sku: 'AB', name: 'x'.repeat(201) }).success).toBe(false);
    expect(productCreateSchema.safeParse({ sku: 'AB', name: 'x'.repeat(200) }).success).toBe(true);
  });

  it('rejects unknown properties on create', () => {
    expect(productCreateSchema.safeParse({ sku: 'AB', name: 'x', isActive: false }).success).toBe(false);
  });

  it('forbids changing the SKU on update (immutable) and empty updates', () => {
    expect(productUpdateSchema.safeParse({ sku: 'NEW' }).success).toBe(false);
    expect(productUpdateSchema.safeParse({}).success).toBe(false);
    expect(productUpdateSchema.safeParse({ name: 'ok' }).success).toBe(true);
    expect(productUpdateSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe('quantity validation (BR-05, BR-06)', () => {
  const line = (quantity: unknown) => receiptCreateSchema.safeParse({ lines: [{ itemId: 1, quantity }] });

  it.each([0, -1, 2.5, 0.1, '3', '', null, undefined, NaN, Infinity, true, [], {}, 1_000_001])(
    'rejects receipt quantity %j',
    (q) => {
      expect(line(q).success).toBe(false);
    },
  );

  it.each([1, 2, 999, 1_000_000])('accepts receipt quantity %j', (q) => {
    expect(line(q).success).toBe(true);
  });

  it('rejects an empty or oversized lines array', () => {
    expect(receiptCreateSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(receiptCreateSchema.safeParse({}).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({ itemId: i + 1, quantity: 1 }));
    expect(receiptCreateSchema.safeParse({ lines: many }).success).toBe(false);
  });

  it('rejects the same item twice in one receipt', () => {
    const r = receiptCreateSchema.safeParse({
      lines: [
        { itemId: 4, quantity: 1 },
        { itemId: 4, quantity: 2 },
      ],
    });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('Each item can appear only once per receipt');
  });

  it('rejects bad item ids', () => {
    for (const itemId of [0, -3, 1.5, '1', null]) {
      expect(receiptCreateSchema.safeParse({ lines: [{ itemId, quantity: 1 }] }).success).toBe(false);
    }
  });
});

describe('document creation validation (BR-03..BR-05, PRD §5.2)', () => {
  const base = { supplierName: 'ACME', items: [{ productId: 1, expectedQuantity: 5 }] };

  it('accepts a minimal document and normalises blanks to null', () => {
    const r = documentCreateSchema.parse({ ...base, referenceNumber: '   ', notes: '' });
    expect(r.referenceNumber).toBeNull();
    expect(r.notes).toBeNull();
  });

  it('requires a supplier', () => {
    expect(documentCreateSchema.safeParse({ ...base, supplierName: '  ' }).success).toBe(false);
    expect(documentCreateSchema.safeParse({ items: base.items }).success).toBe(false);
  });

  it('requires 1..100 items and no duplicate product', () => {
    expect(documentCreateSchema.safeParse({ ...base, items: [] }).success).toBe(false);
    const hundredOne = Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, expectedQuantity: 1 }));
    expect(documentCreateSchema.safeParse({ ...base, items: hundredOne }).success).toBe(false);
    const hundred = hundredOne.slice(0, 100);
    expect(documentCreateSchema.safeParse({ ...base, items: hundred }).success).toBe(true);
    const dup = documentCreateSchema.safeParse({
      ...base,
      items: [
        { productId: 3, expectedQuantity: 1 },
        { productId: 3, expectedQuantity: 2 },
      ],
    });
    expect(dup.success).toBe(false);
  });

  it.each([0, -5, 1.5, '10', null, 1_000_001])('rejects expected quantity %j', (q) => {
    expect(documentCreateSchema.safeParse({ ...base, items: [{ productId: 1, expectedQuantity: q }] }).success).toBe(false);
  });

  it.each(['2025-02-30', '2025-13-01', '25-01-01', '2025/01/01', 'tomorrow', '2025-1-1'])('rejects date %j', (d) => {
    expect(documentCreateSchema.safeParse({ ...base, expectedDate: d }).success).toBe(false);
  });

  it('accepts valid dates including leap day', () => {
    expect(documentCreateSchema.safeParse({ ...base, expectedDate: '2028-02-29' }).success).toBe(true);
    expect(documentCreateSchema.safeParse({ ...base, expectedDate: '2027-02-29' }).success).toBe(false);
  });

  it('cannot set status or other server-controlled fields (strict)', () => {
    expect(documentCreateSchema.safeParse({ ...base, status: 'COMPLETED' }).success).toBe(false);
    expect(documentCreateSchema.safeParse({ ...base, documentNumber: 'RCV-1' }).success).toBe(false);
  });
});

describe('misc helpers', () => {
  it('validates the Idempotency-Key format', () => {
    expect(idempotencyKeySchema.safeParse('9b2c1e84-6b0f-4d3a-9d2e-0a1b2c3d4e5f').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space').success).toBe(false);
  });

  it('escapes LIKE wildcards so search text is literal', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('fails fast on bad configuration', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ JWT_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: 'x', JWT_SECRET: 'x'.repeat(32) }).PORT).toBe(3000);
  });
});
