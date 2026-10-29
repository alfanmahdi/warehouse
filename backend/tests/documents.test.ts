import { afterAll, describe, expect, it } from 'vitest';
import { app, auth, createDocument, createProduct, getDoc, pool, request } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

const post = async (body: unknown, role: 'operator' | 'supervisor' = 'operator') =>
  request(app).post('/api/receiving-documents').set(await auth(role)).send(body as object);

const countDocs = async () => (await pool.query('SELECT count(*)::int AS n FROM receiving_documents')).rows[0].n as number;
const countItems = async () => (await pool.query('SELECT count(*)::int AS n FROM receiving_items')).rows[0].n as number;

describe('create receiving document (US-2)', () => {
  it('AC-2.1 creates an OPEN document with generated number and zero received', async () => {
    const p1 = await createProduct();
    const p2 = await createProduct();
    const res = await post({
      supplierName: '  PT Sumber Makmur ',
      referenceNumber: 'PO-77',
      expectedDate: '2030-01-31',
      notes: 'Dock 3',
      items: [
        { productId: p1.id, expectedQuantity: 10 },
        { productId: p2.id, expectedQuantity: 3 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'OPEN',
      supplierName: 'PT Sumber Makmur',
      referenceNumber: 'PO-77',
      expectedDate: '2030-01-31',
      notes: 'Dock 3',
      itemCount: 2,
      totalExpected: 13,
      totalReceived: 0,
      receipts: [],
      createdBy: { fullName: 'Test Operator' },
    });
    expect(res.body.documentNumber).toMatch(/^RCV-\d{6}$/);
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item.receivedQuantity).toBe(0);
      expect(item.remainingQuantity).toBe(item.expectedQuantity);
    }
  });

  it('FR-DOC-2 document numbers are unique and increasing', async () => {
    const a = (await createDocument([1])).doc;
    const b = (await createDocument([1])).doc;
    expect(a.documentNumber).not.toBe(b.documentNumber);
    expect(Number(b.documentNumber.slice(4))).toBeGreaterThan(Number(a.documentNumber.slice(4)));
  });

  it('supervisors can also create documents', async () => {
    const p = await createProduct();
    expect((await post({ supplierName: 'S', items: [{ productId: p.id, expectedQuantity: 1 }] }, 'supervisor')).status).toBe(201);
  });

  describe('AC-2.2 invalid documents are rejected and nothing is stored', () => {
    const cases: Array<[string, (p: number) => unknown, number, string]> = [
      ['no items', () => ({ supplierName: 'S', items: [] }), 400, 'VALIDATION_ERROR'],
      ['items missing', () => ({ supplierName: 'S' }), 400, 'VALIDATION_ERROR'],
      ['blank supplier', (p) => ({ supplierName: '  ', items: [{ productId: p, expectedQuantity: 1 }] }), 400, 'VALIDATION_ERROR'],
      ['101 items', (p) => ({ supplierName: 'S', items: Array.from({ length: 101 }, (_, i) => ({ productId: p + i, expectedQuantity: 1 })) }), 400, 'VALIDATION_ERROR'],
      ['duplicate product', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: 1 }, { productId: p, expectedQuantity: 2 }] }), 400, 'VALIDATION_ERROR'],
      ['quantity 0', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: 0 }] }), 400, 'VALIDATION_ERROR'],
      ['quantity -4', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: -4 }] }), 400, 'VALIDATION_ERROR'],
      ['quantity 2.5', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: 2.5 }] }), 400, 'VALIDATION_ERROR'],
      ['quantity "5" (string)', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: '5' }] }), 400, 'VALIDATION_ERROR'],
      ['quantity too large', (p) => ({ supplierName: 'S', items: [{ productId: p, expectedQuantity: 1_000_001 }] }), 400, 'VALIDATION_ERROR'],
      ['bad date', (p) => ({ supplierName: 'S', expectedDate: '2025-02-31', items: [{ productId: p, expectedQuantity: 1 }] }), 400, 'VALIDATION_ERROR'],
      ['client-set status', (p) => ({ supplierName: 'S', status: 'COMPLETED', items: [{ productId: p, expectedQuantity: 1 }] }), 400, 'VALIDATION_ERROR'],
      ['unknown product', () => ({ supplierName: 'S', items: [{ productId: 2_000_000_000, expectedQuantity: 1 }] }), 422, 'PRODUCT_NOT_FOUND'],
    ];
    it.each(cases)('%s', async (_name, build, status, code) => {
      const p = await createProduct();
      const docsBefore = await countDocs();
      const itemsBefore = await countItems();
      const res = await post(build(p.id));
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(await countDocs()).toBe(docsBefore);
      expect(await countItems()).toBe(itemsBefore);
    });

    it('inactive product (BR-03) → 422 PRODUCT_INACTIVE, and the document is not created', async () => {
      const p = await createProduct();
      const ok = await createProduct();
      await request(app).patch(`/api/products/${p.id}`).set(await auth('supervisor')).send({ isActive: false });
      const before = await countDocs();
      const res = await post({
        supplierName: 'S',
        items: [{ productId: ok.id, expectedQuantity: 1 }, { productId: p.id, expectedQuantity: 1 }],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PRODUCT_INACTIVE');
      expect(res.body.error.details.skus).toEqual([p.sku]);
      expect(await countDocs()).toBe(before);
    });

    it('a failed creation leaves no orphan items (transaction)', async () => {
      const ok = await createProduct();
      const itemsBefore = await countItems();
      const res = await post({
        supplierName: 'S',
        items: [{ productId: ok.id, expectedQuantity: 1 }, { productId: 2_000_000_000, expectedQuantity: 1 }],
      });
      expect(res.status).toBe(422);
      expect(await countItems()).toBe(itemsBefore);
    });
  });

  it('AC-2.3 the document appears in the list as OPEN', async () => {
    const { doc } = await createDocument([4]);
    const list = await request(app)
      .get('/api/receiving-documents')
      .query({ q: doc.documentNumber })
      .set(await auth('operator'));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: doc.id, status: 'OPEN', itemCount: 1, totalExpected: 4, totalReceived: 0 });
  });
});

describe('read receiving documents (FR-DOC-4, FR-DOC-5)', () => {
  it('detail returns items with expected / received / remaining and 404 for unknown id', async () => {
    const { doc } = await createDocument([5, 7]);
    const res = await request(app).get(`/api/receiving-documents/${doc.id}`).set(await auth('operator'));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { expectedQuantity: number }) => i.expectedQuantity)).toEqual([5, 7]);
    expect((await request(app).get('/api/receiving-documents/99999999').set(await auth('operator'))).status).toBe(404);
    expect((await request(app).get('/api/receiving-documents/abc').set(await auth('operator'))).status).toBe(400);
  });

  it('list is newest-first, filterable by status, and validates its parameters', async () => {
    const first = (await createDocument([1])).doc;
    const second = (await createDocument([1])).doc;
    const h = await auth('operator');

    const list = await request(app).get('/api/receiving-documents').query({ limit: 100 }).set(h);
    const ids = list.body.data.map((d: { id: number }) => d.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    await request(app).post(`/api/receiving-documents/${first.id}/cancel`).set(await auth('supervisor'));
    const cancelled = await request(app).get('/api/receiving-documents').query({ status: 'CANCELLED', limit: 100 }).set(h);
    expect(cancelled.body.data.every((d: { status: string }) => d.status === 'CANCELLED')).toBe(true);
    expect(cancelled.body.data.map((d: { id: number }) => d.id)).toContain(first.id);
    expect(cancelled.body.data.map((d: { id: number }) => d.id)).not.toContain(second.id);

    for (const q of [{ status: 'DONE' }, { limit: 500 }, { offset: -2 }]) {
      expect((await request(app).get('/api/receiving-documents').query(q).set(h)).status, JSON.stringify(q)).toBe(400);
    }
  });

  it('list totals reflect received quantities', async () => {
    const { doc } = await createDocument([10, 5]);
    await request(app)
      .post(`/api/receiving-documents/${doc.id}/receipts`)
      .set(await auth('operator'))
      .send({ lines: [{ itemId: doc.items[0]!.id, quantity: 4 }] });
    const list = await request(app).get('/api/receiving-documents').query({ q: doc.documentNumber }).set(await auth('operator'));
    expect(list.body.data[0]).toMatchObject({ status: 'PARTIALLY_RECEIVED', totalExpected: 15, totalReceived: 4 });
    expect((await getDoc(doc.id)).totalReceived).toBe(4);
  });
});
