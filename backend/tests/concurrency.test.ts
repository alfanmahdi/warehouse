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

describe('AC-4.4 concurrent receipts never exceed the expected quantity (NFR-1)', () => {
  it('10 parallel receipts of 1 against 5 remaining: exactly 5 succeed, 5 get OVER_RECEIPT', async () => {
    const { doc, products } = await createDocument([5]);
    const itemId = doc.items[0]!.id;

    const results = await Promise.all(Array.from({ length: 10 }, () => receive(doc.id, [{ itemId, quantity: 1 }])));

    const ok = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);
    expect(ok).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    // The losers are rejected either as OVER_RECEIPT (item full, doc still open to receipts at check time)
    // or as INVALID_STATE (the 5th receipt already flipped the document to FULLY_RECEIVED) — both are correct refusals.
    for (const r of rejected) {
      expect(['OVER_RECEIPT', 'INVALID_STATE']).toContain(r.body.error.code);
    }

    const after = await getDoc(doc.id);
    expect(after.items[0]).toMatchObject({ receivedQuantity: 5, remainingQuantity: 0 });
    expect(after.status).toBe('FULLY_RECEIVED');
    expect(after.receipts).toHaveLength(5);
    expect(await onHand(products[0]!.id)).toBe(5);
    expect(await ledgerRows(products[0]!.id)).toHaveLength(5);
    expect((await ledgerRows(products[0]!.id)).map((r) => r.balance_after)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parallel receipts of larger quantities: the sum never exceeds expected', async () => {
    const { doc, products } = await createDocument([100]);
    const itemId = doc.items[0]!.id;
    // 8 x 30 = 240 requested vs 100 expected -> at most 3 can win (90), the rest must fail
    const results = await Promise.all(Array.from({ length: 8 }, () => receive(doc.id, [{ itemId, quantity: 30 }])));
    const wins = results.filter((r) => r.status === 201).length;
    expect(wins).toBe(3);
    expect(await onHand(products[0]!.id)).toBe(90);
    expect((await getDoc(doc.id)).items[0]!.receivedQuantity).toBe(90);
  });

  it('the same Idempotency-Key fired 8 times in parallel is applied exactly once', async () => {
    const { doc, products } = await createDocument([20]);
    const lines = [{ itemId: doc.items[0]!.id, quantity: 7 }];

    const results = await Promise.all(Array.from({ length: 8 }, () => receive(doc.id, lines, { key: 'parallel-key-0001' })));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.receipt.id)).size).toBe(1);
    expect(await onHand(products[0]!.id)).toBe(7);
    expect((await getDoc(doc.id)).receipts).toHaveLength(1);
  });

  it('two documents sharing the same products, received in opposite order in parallel: no deadlock, correct totals', async () => {
    const p1 = await createProduct();
    const p2 = await createProduct();
    const make = async (items: Array<{ productId: number; expectedQuantity: number }>) =>
      (await request(app).post('/api/receiving-documents').set(await auth('operator')).send({ supplierName: 'S', items })).body;

    const docA = await make([
      { productId: p1.id, expectedQuantity: 50 },
      { productId: p2.id, expectedQuantity: 50 },
    ]);
    // Same products, listed in the opposite order
    const docB = await make([
      { productId: p2.id, expectedQuantity: 50 },
      { productId: p1.id, expectedQuantity: 50 },
    ]);

    const jobs = [];
    for (let i = 0; i < 10; i++) {
      jobs.push(receive(docA.id, docA.items.map((it: { id: number }) => ({ itemId: it.id, quantity: 5 }))));
      jobs.push(receive(docB.id, [...docB.items].reverse().map((it: { id: number }) => ({ itemId: it.id, quantity: 5 }))));
    }
    const results = await Promise.all(jobs);

    expect(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status))).toBe(true);
    expect(await onHand(p1.id)).toBe(100);
    expect(await onHand(p2.id)).toBe(100);
    expect((await getDoc(docA.id)).status).toBe('FULLY_RECEIVED');
    expect((await getDoc(docB.id)).status).toBe('FULLY_RECEIVED');
  });

  it('receiving and cancelling at the same time never leaves a cancelled document with stock', async () => {
    for (let round = 0; round < 5; round++) {
      const { doc, products } = await createDocument([3]);
      const [rcv, cnl] = await Promise.all([
        receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 3 }]),
        request(app).post(`/api/receiving-documents/${doc.id}/cancel`).set(await auth('supervisor')),
      ]);
      const after = await getDoc(doc.id);
      if (cnl.status === 200) {
        expect(rcv.status).toBe(409);
        expect(after.status).toBe('CANCELLED');
        expect(await onHand(products[0]!.id)).toBe(0);
      } else {
        expect(rcv.status).toBe(201);
        expect(cnl.status).toBe(409);
        expect(after.status).toBe('FULLY_RECEIVED');
        expect(await onHand(products[0]!.id)).toBe(3);
      }
    }
  });

  it('receiving and completing at the same time: completion never succeeds on a not-fully-received document', async () => {
    for (let round = 0; round < 5; round++) {
      const { doc } = await createDocument([4]);
      const [rcv, cmp] = await Promise.all([
        receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 2 }]), // only half
        request(app).post(`/api/receiving-documents/${doc.id}/complete`).set(await auth('supervisor')),
      ]);
      expect(rcv.status).toBe(201);
      expect(cmp.status).toBe(422);
      expect((await getDoc(doc.id)).status).toBe('PARTIALLY_RECEIVED');
    }
  });

  it('stock invariants hold after all the concurrency above', async () => {
    expect(await driftedProducts()).toEqual([]);
    expect(await overReceivedItems()).toEqual([]);
  });
});
