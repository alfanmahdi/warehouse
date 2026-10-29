import { afterAll, describe, expect, it } from 'vitest';
import { app, auth, createProduct, pool, request, uniqueSku } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

describe('products (US-1, BR-01, BR-02)', () => {
  it('AC-1.1 supervisor creates a product; it appears in the list (SKU upper-cased)', async () => {
    const sku = uniqueSku('p1');
    const res = await request(app)
      .post('/api/products')
      .set(await auth('supervisor'))
      .send({ sku: sku.toLowerCase(), name: '  Pallet jack  ', description: 'Manual' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sku, name: 'Pallet jack', description: 'Manual', isActive: true });

    const list = await request(app).get('/api/products').query({ q: sku }).set(await auth('operator'));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].id).toBe(res.body.id);
  });

  it('AC-1.2 duplicate SKU → 409 DUPLICATE_SKU, also across letter case', async () => {
    const p = await createProduct('Original');
    for (const sku of [p.sku, p.sku.toLowerCase(), `  ${p.sku.toLowerCase()} `]) {
      const res = await request(app).post('/api/products').set(await auth('supervisor')).send({ sku, name: 'Copy' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DUPLICATE_SKU');
    }
  });

  it('AC-1.2 concurrent creation of the same SKU: exactly one wins', async () => {
    const sku = uniqueSku('race');
    const h = await auth('supervisor');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/products').set(h).send({ sku, name: 'Racer' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const { rows } = await pool.query('SELECT 1 FROM products WHERE sku = $1', [sku]);
    expect(rows).toHaveLength(1);
  });

  it.each([
    [{ sku: '', name: 'x' }],
    [{ sku: 'a b', name: 'x' }],
    [{ sku: 'x'.repeat(40), name: 'x' }],
    [{ sku: 'OK-1' }],
    [{ sku: 'OK-1', name: '   ' }],
    [{ sku: 'OK-1', name: 'x'.repeat(201) }],
    [{ sku: 'OK-1', name: 'x', description: 'd'.repeat(1001) }],
    [{ sku: 123, name: 'x' }],
    [{ sku: 'OK-1', name: 'x', isActive: false }],
  ])('AC-1.3 invalid body %j → 400 VALIDATION_ERROR and nothing stored', async (body) => {
    const before = await pool.query('SELECT count(*)::int AS n FROM products');
    const res = await request(app).post('/api/products').set(await auth('supervisor')).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    const after = await pool.query('SELECT count(*)::int AS n FROM products');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('AC-1.4 operator cannot create or update', async () => {
    const p = await createProduct();
    const h = await auth('operator');
    expect((await request(app).post('/api/products').set(h).send({ sku: uniqueSku(), name: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/products/${p.id}`).set(h).send({ name: 'Hacked' })).status).toBe(403);
  });

  it('AC-1.5 SKU cannot be changed on update', async () => {
    const p = await createProduct();
    const res = await request(app).patch(`/api/products/${p.id}`).set(await auth('supervisor')).send({ sku: 'CHANGED-1' });
    expect(res.status).toBe(400);
    const after = await request(app).get(`/api/products/${p.id}`).set(await auth('operator'));
    expect(after.body.sku).toBe(p.sku);
  });

  it('supervisor can update name, description and active flag', async () => {
    const p = await createProduct('Old');
    const h = await auth('supervisor');
    const upd = await request(app).patch(`/api/products/${p.id}`).set(h).send({ name: 'New', description: 'Desc', isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'New', description: 'Desc', isActive: false, sku: p.sku });

    const clear = await request(app).patch(`/api/products/${p.id}`).set(h).send({ description: null });
    expect(clear.body.description).toBeNull();
    expect(clear.body.name).toBe('New'); // untouched fields stay
  });

  it('empty update body → 400', async () => {
    const p = await createProduct();
    expect((await request(app).patch(`/api/products/${p.id}`).set(await auth('supervisor')).send({})).status).toBe(400);
  });

  it('get by id: 200 / 404 / 400 for non-numeric ids', async () => {
    const p = await createProduct();
    const h = await auth('operator');
    expect((await request(app).get(`/api/products/${p.id}`).set(h)).status).toBe(200);
    expect((await request(app).get('/api/products/99999999').set(h)).status).toBe(404);
    for (const bad of ['abc', '1.5', '-1', '0', '1e2', '99999999999']) {
      const res = await request(app).get(`/api/products/${bad}`).set(h);
      expect(res.status, bad).toBe(400);
    }
  });

  it('list supports search, active filter and pagination; bad params → 400', async () => {
    const prefix = uniqueSku('lst');
    const a = await createProduct('Searchable Alpha', `${prefix}-A`);
    await createProduct('Searchable Beta', `${prefix}-B`);
    await request(app).patch(`/api/products/${a.id}`).set(await auth('supervisor')).send({ isActive: false });
    const h = await auth('operator');

    const all = await request(app).get('/api/products').query({ q: prefix }).set(h);
    expect(all.body.total).toBe(2);
    const inactive = await request(app).get('/api/products').query({ q: prefix, active: 'false' }).set(h);
    expect(inactive.body.data.map((p: { id: number }) => p.id)).toEqual([a.id]);
    const page = await request(app).get('/api/products').query({ q: prefix, limit: 1, offset: 1 }).set(h);
    expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page.body.data).toHaveLength(1);

    for (const q of [{ limit: 0 }, { limit: 101 }, { limit: 'x' }, { offset: -1 }, { active: 'maybe' }]) {
      expect((await request(app).get('/api/products').query(q).set(h)).status, JSON.stringify(q)).toBe(400);
    }
  });

  it('search treats % and _ literally (no wildcard injection)', async () => {
    const res = await request(app).get('/api/products').query({ q: '%' }).set(await auth('operator'));
    expect(res.status).toBe(200);
    for (const p of res.body.data) expect(`${p.sku}${p.name}`).toContain('%');
  });
});
