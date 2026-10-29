import { afterAll, describe, expect, it } from 'vitest';
import { app, auth, createDocument, driftedProducts, getDoc, onHand, pool, receive, request } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

const complete = async (id: number, role: 'operator' | 'supervisor' = 'supervisor') =>
  request(app).post(`/api/receiving-documents/${id}/complete`).set(await auth(role));
const cancel = async (id: number, role: 'operator' | 'supervisor' = 'supervisor') =>
  request(app).post(`/api/receiving-documents/${id}/cancel`).set(await auth(role));

const receiveAll = async (doc: Awaited<ReturnType<typeof createDocument>>['doc']) =>
  receive(doc.id, doc.items.map((i) => ({ itemId: i.id, quantity: i.expectedQuantity })));

describe('US-6 complete a document (BR-10)', () => {
  it('AC-6.1 supervisor completes a fully received document', async () => {
    const { doc } = await createDocument([3, 4]);
    await receiveAll(doc);
    const res = await complete(doc.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.completedBy).toMatchObject({ fullName: 'Test Supervisor' });
    expect(res.body.completedAt).toEqual(expect.any(String));
  });

  it('AC-6.2 refuses while any item is still open and lists the unfinished items', async () => {
    const { doc, products } = await createDocument([3, 4]);
    await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 3 }, { itemId: doc.items[1]!.id, quantity: 1 }]);
    const res = await complete(doc.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_FULLY_RECEIVED');
    expect(res.body.error.details.openItems).toEqual([
      expect.objectContaining({ itemId: doc.items[1]!.id, sku: products[1]!.sku, expected: 4, received: 1, remaining: 3 }),
    ]);
    expect((await getDoc(doc.id)).status).toBe('PARTIALLY_RECEIVED');
  });

  it('AC-6.2 refuses a document with nothing received (OPEN)', async () => {
    const { doc } = await createDocument([1]);
    const res = await complete(doc.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_FULLY_RECEIVED');
    expect((await getDoc(doc.id)).status).toBe('OPEN');
  });

  it('AC-6.3 an operator cannot complete', async () => {
    const { doc } = await createDocument([1]);
    await receiveAll(doc);
    const res = await complete(doc.id, 'operator');
    expect(res.status).toBe(403);
    expect((await getDoc(doc.id)).status).toBe('FULLY_RECEIVED');
  });

  it('AC-6.4 completing twice, or a cancelled document → 409 INVALID_STATE', async () => {
    const { doc } = await createDocument([1]);
    await receiveAll(doc);
    expect((await complete(doc.id)).status).toBe(200);
    const again = await complete(doc.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');

    const other = (await createDocument([1])).doc;
    await cancel(other.id);
    expect((await complete(other.id)).status).toBe(409);
  });

  it('AC-6.5 receipts on COMPLETED / CANCELLED / FULLY_RECEIVED documents → 409 INVALID_STATE, stock untouched', async () => {
    const full = await createDocument([2]);
    await receiveAll(full.doc);
    const afterFull = await receive(full.doc.id, [{ itemId: full.doc.items[0]!.id, quantity: 1 }]);
    expect(afterFull.status).toBe(409);
    expect(afterFull.body.error.code).toBe('INVALID_STATE');

    await complete(full.doc.id);
    const afterComplete = await receive(full.doc.id, [{ itemId: full.doc.items[0]!.id, quantity: 1 }]);
    expect(afterComplete.status).toBe(409);
    expect(afterComplete.body.error.code).toBe('INVALID_STATE');
    expect(await onHand(full.products[0]!.id)).toBe(2);

    const cancelled = await createDocument([5]);
    await cancel(cancelled.doc.id);
    const afterCancel = await receive(cancelled.doc.id, [{ itemId: cancelled.doc.items[0]!.id, quantity: 1 }]);
    expect(afterCancel.status).toBe(409);
    expect(afterCancel.body.error.code).toBe('INVALID_STATE');
    expect(await onHand(cancelled.products[0]!.id)).toBe(0);
  });

  it('completion is judged on item data, not on the cached status (BR-10 defence in depth)', async () => {
    // Simulate corrupted status: the document claims FULLY_RECEIVED but an item is still open.
    const { doc } = await createDocument([5]);
    await pool.query("UPDATE receiving_documents SET status = 'FULLY_RECEIVED' WHERE id = $1", [doc.id]);
    const res = await complete(doc.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_FULLY_RECEIVED');
    const { rows } = await pool.query('SELECT status FROM receiving_documents WHERE id = $1', [doc.id]);
    expect(rows[0].status).toBe('FULLY_RECEIVED'); // unchanged, not COMPLETED
  });

  it('unknown document → 404', async () => {
    expect((await complete(99_999_999)).status).toBe(404);
  });
});

describe('US-7 cancel a document (BR-11)', () => {
  it('AC-7.1 supervisor cancels an OPEN document; inventory is unaffected', async () => {
    const { doc, products } = await createDocument([5]);
    const res = await cancel(doc.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelledBy).toMatchObject({ fullName: 'Test Supervisor' });
    expect(await onHand(products[0]!.id)).toBe(0);
  });

  it('AC-7.2 cannot cancel PARTIALLY_RECEIVED, FULLY_RECEIVED, COMPLETED or CANCELLED documents', async () => {
    const partial = (await createDocument([5])).doc;
    await receive(partial.id, [{ itemId: partial.items[0]!.id, quantity: 1 }]);
    const full = (await createDocument([1])).doc;
    await receiveAll(full);
    const done = (await createDocument([1])).doc;
    await receiveAll(done);
    await complete(done.id);
    const gone = (await createDocument([1])).doc;
    await cancel(gone.id);

    for (const [doc, status] of [
      [partial, 'PARTIALLY_RECEIVED'],
      [full, 'FULLY_RECEIVED'],
      [done, 'COMPLETED'],
      [gone, 'CANCELLED'],
    ] as const) {
      const res = await cancel(doc.id);
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
      expect((await getDoc(doc.id)).status).toBe(status);
    }
  });

  it('AC-7.3 an operator cannot cancel', async () => {
    const { doc } = await createDocument([5]);
    expect((await cancel(doc.id, 'operator')).status).toBe(403);
    expect((await getDoc(doc.id)).status).toBe('OPEN');
  });

  it('a cancelled document keeps its items and stays visible (BR-16: nothing is deleted)', async () => {
    const { doc } = await createDocument([5, 6]);
    await cancel(doc.id);
    const after = await getDoc(doc.id);
    expect(after.status).toBe('CANCELLED');
    expect(after.items).toHaveLength(2);
  });
});

describe('full happy path (US-2 → US-8)', () => {
  it('create → partial → partial → full → complete, with inventory and history correct at each step', async () => {
    const { doc, products } = await createDocument([10, 2]);
    const [a, b] = doc.items as [(typeof doc.items)[0], (typeof doc.items)[0]];

    expect((await receive(doc.id, [{ itemId: a.id, quantity: 4 }])).body.document.status).toBe('PARTIALLY_RECEIVED');
    expect((await receive(doc.id, [{ itemId: a.id, quantity: 6 }])).body.document.status).toBe('PARTIALLY_RECEIVED');
    expect((await complete(doc.id)).status).toBe(422); // item b still open
    expect((await receive(doc.id, [{ itemId: b.id, quantity: 2 }])).body.document.status).toBe('FULLY_RECEIVED');
    expect((await complete(doc.id)).body.status).toBe('COMPLETED');

    expect(await onHand(products[0]!.id)).toBe(10);
    expect(await onHand(products[1]!.id)).toBe(2);

    const h = await auth('operator');
    const inv = await request(app).get('/api/inventory').query({ q: products[0]!.sku }).set(h);
    expect(inv.body.data[0]).toMatchObject({ sku: products[0]!.sku, quantityOnHand: 10 });

    const history = await request(app).get('/api/inventory/transactions').query({ productId: products[0]!.id }).set(h);
    expect(history.body.total).toBe(2);
    expect(history.body.data.map((t: { quantityChange: number }) => t.quantityChange)).toEqual([6, 4]); // newest first
    expect(history.body.data[0].balanceAfter).toBe(10);

    expect(await driftedProducts()).toEqual([]);
  });
});

describe('US-8 inventory views', () => {
  it('AC-8.1 lists products with zero stock too', async () => {
    const { products } = await createDocument([5]);
    const res = await request(app).get('/api/inventory').query({ q: products[0]!.sku }).set(await auth('operator'));
    expect(res.body.data).toEqual([expect.objectContaining({ productId: products[0]!.id, quantityOnHand: 0, updatedAt: null })]);
  });

  it('AC-8.2 history is newest first, filterable, paginated and validated', async () => {
    const { doc, products } = await createDocument([9]);
    for (const q of [1, 2, 3]) await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: q }]);
    const h = await auth('operator');
    const page1 = await request(app).get('/api/inventory/transactions').query({ productId: products[0]!.id, limit: 2 }).set(h);
    expect(page1.body).toMatchObject({ total: 3, limit: 2, offset: 0 });
    expect(page1.body.data.map((t: { quantityChange: number }) => t.quantityChange)).toEqual([3, 2]);
    const page2 = await request(app).get('/api/inventory/transactions').query({ productId: products[0]!.id, limit: 2, offset: 2 }).set(h);
    expect(page2.body.data.map((t: { quantityChange: number }) => t.quantityChange)).toEqual([1]);

    for (const q of [{ productId: 'abc' }, { productId: 0 }, { limit: 0 }, { offset: -1 }]) {
      expect((await request(app).get('/api/inventory/transactions').query(q).set(h)).status, JSON.stringify(q)).toBe(400);
    }
  });

  it('there is no API to write inventory or the ledger directly', async () => {
    const h = await auth('supervisor');
    for (const [method, path] of [
      ['post', '/api/inventory'],
      ['put', '/api/inventory/1'],
      ['patch', '/api/inventory/transactions'],
      ['delete', '/api/inventory/transactions'],
      ['post', '/api/inventory/transactions'],
    ] as const) {
      const res = await request(app)[method](path).set(h).send({ quantityOnHand: 9999 });
      expect([404, 405], `${method} ${path}`).toContain(res.status);
    }
  });
});
