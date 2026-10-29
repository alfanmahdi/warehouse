import { afterAll, describe, expect, it } from 'vitest';
import {
  app,
  auth,
  createDocument,
  createProduct,
  driftedProducts,
  getDoc,
  ledgerRows,
  onHand,
  overReceivedItems,
  pool,
  receive,
  request,
} from './helpers.js';

afterAll(async () => {
  await pool.end();
});

describe('US-3 partial and full receipts', () => {
  it('AC-3.1 partial receipt updates item, status, inventory and ledger together', async () => {
    const { doc, products } = await createDocument([10]);
    const item = doc.items[0]!;

    const res = await receive(doc.id, [{ itemId: item.id, quantity: 4 }]);
    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('PARTIALLY_RECEIVED');
    expect(res.body.document.items[0]).toMatchObject({ receivedQuantity: 4, remainingQuantity: 6 });
    expect(res.body.receipt.lines).toEqual([
      expect.objectContaining({ itemId: item.id, productId: products[0]!.id, quantity: 4, balanceAfter: 4 }),
    ]);

    expect(await onHand(products[0]!.id)).toBe(4);
    expect(await ledgerRows(products[0]!.id)).toEqual([{ quantity_change: 4, balance_after: 4 }]);
  });

  it('AC-3.2 a second receipt completes the item; status becomes FULLY_RECEIVED', async () => {
    const { doc, products } = await createDocument([10]);
    const item = doc.items[0]!;
    await receive(doc.id, [{ itemId: item.id, quantity: 4 }]);
    const res = await receive(doc.id, [{ itemId: item.id, quantity: 6 }]);

    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('FULLY_RECEIVED');
    expect(res.body.document.items[0]).toMatchObject({ receivedQuantity: 10, remainingQuantity: 0 });
    expect(await onHand(products[0]!.id)).toBe(10);
    expect(await ledgerRows(products[0]!.id)).toEqual([
      { quantity_change: 4, balance_after: 4 },
      { quantity_change: 6, balance_after: 10 },
    ]);
    expect((await getDoc(doc.id)).receipts).toHaveLength(2);
  });

  it('AC-3.3 several items in one request are all applied; a full receipt in one go → FULLY_RECEIVED', async () => {
    const { doc, products } = await createDocument([3, 8]);
    const res = await receive(doc.id, doc.items.map((i) => ({ itemId: i.id, quantity: i.expectedQuantity })));
    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('FULLY_RECEIVED');
    expect(await onHand(products[0]!.id)).toBe(3);
    expect(await onHand(products[1]!.id)).toBe(8);
    expect(res.body.receipt.lines).toHaveLength(2);
  });

  it('receiving only one of two items leaves the document PARTIALLY_RECEIVED', async () => {
    const { doc } = await createDocument([3, 8]);
    const res = await receive(doc.id, [{ itemId: doc.items[1]!.id, quantity: 8 }]);
    expect(res.body.document.status).toBe('PARTIALLY_RECEIVED');
    expect(res.body.document.items[0].receivedQuantity).toBe(0);
    expect(res.body.document.items[1].remainingQuantity).toBe(0);
  });

  it('stock accumulates across different documents for the same product (balance_after is cumulative)', async () => {
    const product = await createProduct();
    const make = async (qty: number) =>
      (
        await request(app)
          .post('/api/receiving-documents')
          .set(await auth('operator'))
          .send({ supplierName: 'S', items: [{ productId: product.id, expectedQuantity: qty }] })
      ).body;
    const d1 = await make(5);
    const d2 = await make(7);
    await receive(d1.id, [{ itemId: d1.items[0].id, quantity: 5 }]);
    await receive(d2.id, [{ itemId: d2.items[0].id, quantity: 7 }]);
    expect(await onHand(product.id)).toBe(12);
    expect(await ledgerRows(product.id)).toEqual([
      { quantity_change: 5, balance_after: 5 },
      { quantity_change: 7, balance_after: 12 },
    ]);
  });

  it('a supervisor can record receipts too', async () => {
    const { doc } = await createDocument([2]);
    expect((await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 2 }], { role: 'supervisor' })).status).toBe(201);
  });

  it('records who received (audit trail)', async () => {
    const { doc, products } = await createDocument([2]);
    const res = await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 1 }]);
    expect(res.body.receipt.receivedBy.fullName).toBe('Test Operator');
    const tx = await request(app)
      .get('/api/inventory/transactions')
      .query({ productId: products[0]!.id })
      .set(await auth('supervisor'));
    expect(tx.body.data[0]).toMatchObject({
      type: 'RECEIPT',
      quantityChange: 1,
      balanceAfter: 1,
      documentNumber: doc.documentNumber,
      createdBy: { fullName: 'Test Operator' },
    });
  });
});

describe('US-4 over-receipt and invalid quantities (BR-06, BR-08)', () => {
  it('AC-4.1 receiving more than remaining → 422 OVER_RECEIPT, nothing changes', async () => {
    const { doc, products } = await createDocument([10]);
    const item = doc.items[0]!;
    await receive(doc.id, [{ itemId: item.id, quantity: 4 }]);

    const res = await receive(doc.id, [{ itemId: item.id, quantity: 7 }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_RECEIPT');
    expect(res.body.error.details).toMatchObject({ itemId: item.id, requested: 7, remaining: 6 });

    const after = await getDoc(doc.id);
    expect(after.items[0]).toMatchObject({ receivedQuantity: 4, remainingQuantity: 6 });
    expect(after.status).toBe('PARTIALLY_RECEIVED');
    expect(after.receipts).toHaveLength(1);
    expect(await onHand(products[0]!.id)).toBe(4);
    expect(await ledgerRows(products[0]!.id)).toHaveLength(1);
  });

  it('exactly the remaining quantity is allowed; one more is not (boundary)', async () => {
    const { doc } = await createDocument([5]);
    const item = doc.items[0]!;
    expect((await receive(doc.id, [{ itemId: item.id, quantity: 6 }])).status).toBe(422);
    expect((await receive(doc.id, [{ itemId: item.id, quantity: 5 }])).status).toBe(201);
    // nothing left: any further quantity is rejected — as INVALID_STATE because the document is now FULLY_RECEIVED
    const again = await receive(doc.id, [{ itemId: item.id, quantity: 1 }]);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('an item that is already full is rejected as OVER_RECEIPT while the document is still PARTIALLY_RECEIVED', async () => {
    const { doc, products } = await createDocument([2, 9]);
    await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 2 }]);
    const res = await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 1 }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_RECEIPT');
    expect(res.body.error.details.remaining).toBe(0);
    expect(await onHand(products[0]!.id)).toBe(2);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['decimal', 2.5],
    ['string "3"', '3'],
    ['empty string', ''],
    ['null', null],
    ['boolean', true],
    ['array', [1]],
    ['object', { n: 1 }],
    ['over the per-line maximum', 1_000_001],
  ])('AC-4.2 quantity %s → 400 VALIDATION_ERROR and nothing changes', async (_label, quantity) => {
    const { doc, products } = await createDocument([10]);
    const res = await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await getDoc(doc.id)).items[0]!.receivedQuantity).toBe(0);
    expect(await onHand(products[0]!.id)).toBe(0);
  });

  it('AC-4.2 missing quantity / missing lines / wrong shapes → 400', async () => {
    const { doc } = await createDocument([10]);
    const h = await auth('operator');
    const url = `/api/receiving-documents/${doc.id}/receipts`;
    const itemId = doc.items[0]!.id;
    for (const body of [{}, { lines: [] }, { lines: [{ itemId }] }, { lines: [{ quantity: 1 }] }, { lines: 'x' }, { lines: [{ itemId, quantity: 1, extra: 1 }] }, []]) {
      const res = await request(app).post(url).set(h).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).post(url).set(h)).status).toBe(400); // no body at all
    expect((await getDoc(doc.id)).status).toBe('OPEN');
  });

  it('AC-4.3 atomicity: if the second line is invalid, the first line is NOT applied', async () => {
    const { doc, products } = await createDocument([10, 5]);
    const [a, b] = doc.items as [(typeof doc.items)[0], (typeof doc.items)[0]];

    const res = await receive(doc.id, [
      { itemId: a.id, quantity: 3 },
      { itemId: b.id, quantity: 6 }, // only 5 expected
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_RECEIPT');

    const after = await getDoc(doc.id);
    expect(after.status).toBe('OPEN');
    expect(after.items.map((i) => i.receivedQuantity)).toEqual([0, 0]);
    expect(after.receipts).toHaveLength(0);
    expect(await onHand(products[0]!.id)).toBe(0);
    expect(await onHand(products[1]!.id)).toBe(0);
    expect(await ledgerRows(products[0]!.id)).toHaveLength(0);
    const orphan = await pool.query('SELECT 1 FROM receipts WHERE document_id = $1', [doc.id]);
    expect(orphan.rowCount).toBe(0);
  });

  it('atomicity also holds when the invalid line comes FIRST and when an item id does not exist', async () => {
    const { doc, products } = await createDocument([10, 5]);
    const r1 = await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 11 }, { itemId: doc.items[1]!.id, quantity: 1 }]);
    expect(r1.status).toBe(422);
    const r2 = await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 1 }, { itemId: 2_000_000_000, quantity: 1 }]);
    expect(r2.status).toBe(404);
    expect(await onHand(products[0]!.id)).toBe(0);
    expect(await onHand(products[1]!.id)).toBe(0);
  });

  it('AC-4.5 an item of ANOTHER document → 422 ITEM_NOT_IN_DOCUMENT, and nothing is applied to either document', async () => {
    const a = (await createDocument([5])).doc;
    const b = (await createDocument([5])).doc;
    const res = await receive(a.id, [{ itemId: b.items[0]!.id, quantity: 1 }]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ITEM_NOT_IN_DOCUMENT');
    expect((await getDoc(a.id)).items[0]!.receivedQuantity).toBe(0);
    expect((await getDoc(b.id)).items[0]!.receivedQuantity).toBe(0);
  });

  it('the same item twice in one request is rejected, not silently summed', async () => {
    const { doc } = await createDocument([10]);
    const id = doc.items[0]!.id;
    const res = await receive(doc.id, [{ itemId: id, quantity: 6 }, { itemId: id, quantity: 6 }]);
    expect(res.status).toBe(400);
    expect((await getDoc(doc.id)).items[0]!.receivedQuantity).toBe(0);
  });

  it('unknown document → 404; bad document id → 400', async () => {
    expect((await receive(99_999_999, [{ itemId: 1, quantity: 1 }])).status).toBe(404);
    const res = await request(app)
      .post('/api/receiving-documents/abc/receipts')
      .set(await auth('operator'))
      .send({ lines: [{ itemId: 1, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('inactive product can still be received on an existing document (BR-03 / A7)', async () => {
    const { doc, products } = await createDocument([5]);
    await request(app).patch(`/api/products/${products[0]!.id}`).set(await auth('supervisor')).send({ isActive: false });
    expect((await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 5 }])).status).toBe(201);
    expect(await onHand(products[0]!.id)).toBe(5);
  });
});

describe('US-5 idempotent retries (BR-13)', () => {
  it('AC-5.1 same key + same lines: first 201, replay 200 with the same receipt; stock increased once', async () => {
    const { doc, products } = await createDocument([10]);
    const lines = [{ itemId: doc.items[0]!.id, quantity: 4 }];
    const first = await receive(doc.id, lines, { key: 'key-first-0001' });
    const second = await receive(doc.id, lines, { key: 'key-first-0001' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.receipt.id).toBe(first.body.receipt.id);
    expect(await onHand(products[0]!.id)).toBe(4);
    expect(await ledgerRows(products[0]!.id)).toHaveLength(1);
    expect((await getDoc(doc.id)).receipts).toHaveLength(1);
  });

  it('a replay still returns the original even after the document became FULLY_RECEIVED', async () => {
    const { doc, products } = await createDocument([3]);
    const lines = [{ itemId: doc.items[0]!.id, quantity: 3 }];
    expect((await receive(doc.id, lines, { key: 'key-full-0002' })).status).toBe(201);
    const replay = await receive(doc.id, lines, { key: 'key-full-0002' });
    expect(replay.status).toBe(200);
    expect(await onHand(products[0]!.id)).toBe(3);
  });

  it('AC-5.2 same key with different lines → 409 IDEMPOTENCY_KEY_REUSED, nothing applied', async () => {
    const { doc, products } = await createDocument([10]);
    const itemId = doc.items[0]!.id;
    await receive(doc.id, [{ itemId, quantity: 4 }], { key: 'key-diff-0003' });
    const res = await receive(doc.id, [{ itemId, quantity: 5 }], { key: 'key-diff-0003' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await onHand(products[0]!.id)).toBe(4);
  });

  it('AC-5.2 same key on a different document → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const a = (await createDocument([5])).doc;
    const b = (await createDocument([5])).doc;
    await receive(a.id, [{ itemId: a.items[0]!.id, quantity: 1 }], { key: 'key-doc-0004' });
    const res = await receive(b.id, [{ itemId: b.items[0]!.id, quantity: 1 }], { key: 'key-doc-0004' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await getDoc(b.id)).items[0]!.receivedQuantity).toBe(0);
  });

  it('AC-5.3 without a key the same quantities are a NEW receipt, still bounded by BR-06', async () => {
    const { doc, products } = await createDocument([10]);
    const lines = [{ itemId: doc.items[0]!.id, quantity: 4 }];
    expect((await receive(doc.id, lines)).status).toBe(201);
    expect((await receive(doc.id, lines)).status).toBe(201);
    expect((await receive(doc.id, lines)).status).toBe(422); // 12 > 10
    expect(await onHand(products[0]!.id)).toBe(8);
  });

  it('a failed attempt does not "burn" the key: it can be reused after the error is fixed', async () => {
    const { doc, products } = await createDocument([5]);
    const itemId = doc.items[0]!.id;
    expect((await receive(doc.id, [{ itemId, quantity: 9 }], { key: 'key-retry-0005' })).status).toBe(422);
    expect((await receive(doc.id, [{ itemId, quantity: 5 }], { key: 'key-retry-0005' })).status).toBe(201);
    expect(await onHand(products[0]!.id)).toBe(5);
  });

  it('invalid key formats → 400', async () => {
    const { doc } = await createDocument([5]);
    const lines = [{ itemId: doc.items[0]!.id, quantity: 1 }];
    expect((await receive(doc.id, lines, { key: 'x'.repeat(129) })).status).toBe(400);
    expect((await receive(doc.id, lines, { key: 'has space' })).status).toBe(400);
    expect((await getDoc(doc.id)).receipts).toHaveLength(0);
  });
});

describe('global invariants after all receiving tests (BR-14, NFR-1)', () => {
  it('on_hand equals the sum of the ledger for every product', async () => {
    expect(await driftedProducts()).toEqual([]);
  });
  it('no item anywhere has received > expected or < 0', async () => {
    expect(await overReceivedItems()).toEqual([]);
  });
});
