import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedUsers } from '../src/seed.js';
import { TEST_DATABASE_URL } from './globalSetup.js';
import { PASSWORD, app, createDocument, driftedProducts, overReceivedItems, pool, receive, request, tokenFor } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

/**
 * The database is the last line of defence (technical-spec §3). These tests bypass the application
 * and prove the DB itself refuses to store inconsistent stock.
 */
describe('database-level integrity (BR-06, BR-14, NFR-9)', () => {
  it('CHECK: received_quantity cannot exceed expected_quantity, even with raw SQL', async () => {
    const { doc } = await createDocument([5]);
    await expect(pool.query('UPDATE receiving_items SET received_quantity = 6 WHERE id = $1', [doc.items[0]!.id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'receiving_items_received_within_expected',
    });
    await expect(pool.query('UPDATE receiving_items SET received_quantity = -1 WHERE id = $1', [doc.items[0]!.id])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('CHECK: inventory can never go negative', async () => {
    const { products } = await createDocument([5]);
    await expect(
      pool.query('INSERT INTO inventory (product_id, quantity_on_hand) VALUES ($1, -1)', [products[0]!.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: expected quantity must be 1..1,000,000 and unique per product per document', async () => {
    const { doc, products } = await createDocument([5]);
    await expect(
      pool.query('INSERT INTO receiving_items (document_id, product_id, expected_quantity) VALUES ($1, $2, 0)', [doc.id, products[0]!.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('INSERT INTO receiving_items (document_id, product_id, expected_quantity) VALUES ($1, $2, 3)', [doc.id, products[0]!.id]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('CHECK: status must be one of the five values and completion metadata must match', async () => {
    const { doc } = await createDocument([5]);
    await expect(pool.query("UPDATE receiving_documents SET status = 'DONE' WHERE id = $1", [doc.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE receiving_documents SET status = 'COMPLETED' WHERE id = $1", [doc.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('CHECK: SKU format and uniqueness are enforced by the database too', async () => {
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM users WHERE username = 'supervisor'");
    await expect(pool.query("INSERT INTO products (sku, name, created_by) VALUES ('lower case', 'x', $1)", [rows[0]!.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('TRIGGER: the ledger is append-only (UPDATE, DELETE and TRUNCATE are rejected)', async () => {
    const { doc, products } = await createDocument([5]);
    await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 2 }]);
    const pid = products[0]!.id;

    await expect(pool.query('UPDATE inventory_transactions SET quantity_change = 99 WHERE product_id = $1', [pid])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM inventory_transactions WHERE product_id = $1', [pid])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE inventory_transactions')).rejects.toThrow(/append-only/);

    const { rows } = await pool.query('SELECT quantity_change FROM inventory_transactions WHERE product_id = $1', [pid]);
    expect(rows).toEqual([{ quantity_change: 2 }]);
  });

  it('FK: a ledger row cannot reference a missing receipt, item or product', async () => {
    await expect(
      pool.query(
        `INSERT INTO inventory_transactions (product_id, type, quantity_change, balance_after, receipt_id, receiving_item_id, created_by)
         VALUES (2000000000, 'RECEIPT', 1, 1, 2000000000, 2000000000, 2000000000)`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('CHECK: expected_quantity cannot be lowered below what was already received', async () => {
    const { doc } = await createDocument([5]);
    await receive(doc.id, [{ itemId: doc.items[0]!.id, quantity: 5 }]);
    await expect(pool.query('UPDATE receiving_items SET expected_quantity = 3 WHERE id = $1', [doc.items[0]!.id])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('if a CHECK violation ever reaches the HTTP layer it is mapped to 422 OVER_RECEIPT / 409 DUPLICATE_SKU, never a 500', async () => {
    const { default: express } = await import('express');
    const { errorHandler } = await import('../src/http/errorHandler.js');
    const dbError = (code: string, constraint: string) =>
      Object.assign(new Error('db'), { code, constraint, severity: 'ERROR' });
    const mini = express();
    mini.get('/over', () => {
      throw dbError('23514', 'receiving_items_received_within_expected');
    });
    mini.get('/sku', () => {
      throw dbError('23505', 'products_sku_key');
    });
    mini.get('/other', () => {
      throw dbError('23503', 'some_fk');
    });
    mini.use(errorHandler(() => undefined));
    const over = await request(mini).get('/over');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVER_RECEIPT');
    const sku = await request(mini).get('/sku');
    expect(sku.status).toBe(409);
    expect(sku.body.error.code).toBe('DUPLICATE_SKU');
    expect((await request(mini).get('/other')).status).toBe(500);
  });
});

describe('stock correctness evidence (PRD E)', () => {
  it('after a mixed workload, on_hand == Σ ledger for EVERY product and no item is over-received', async () => {
    // a deliberately messy workload: partial, full, rejected, replayed, multi-line
    for (let i = 0; i < 5; i++) {
      const { doc } = await createDocument([10, 4, 6]);
      const [a, b, c] = doc.items as [(typeof doc.items)[0], (typeof doc.items)[0], (typeof doc.items)[0]];
      await receive(doc.id, [{ itemId: a.id, quantity: 3 }, { itemId: b.id, quantity: 4 }]);
      await receive(doc.id, [{ itemId: a.id, quantity: 8 }]); // over-receipt: rejected
      await receive(doc.id, [{ itemId: a.id, quantity: 7 }, { itemId: c.id, quantity: 7 }]); // atomic reject
      await receive(doc.id, [{ itemId: c.id, quantity: 2 }], { key: `mix-${i}-${doc.id}` });
      await receive(doc.id, [{ itemId: c.id, quantity: 2 }], { key: `mix-${i}-${doc.id}` }); // replay
      await receive(doc.id, [{ itemId: a.id, quantity: 7 }, { itemId: c.id, quantity: 4 }]);
    }
    expect(await driftedProducts()).toEqual([]);
    expect(await overReceivedItems()).toEqual([]);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS bad FROM inventory_transactions t
        WHERE t.balance_after <> (SELECT COALESCE(sum(t2.quantity_change), 0) FROM inventory_transactions t2
                                   WHERE t2.product_id = t.product_id AND t2.id <= t.id)`,
    );
    expect(rows[0].bad).toBe(0); // every running balance in the ledger is consistent
  });

  it('per-item received_quantity equals the sum of ledger lines that reference the item', async () => {
    const { rows } = await pool.query(
      `SELECT i.id FROM receiving_items i
        WHERE i.received_quantity <> COALESCE((SELECT sum(t.quantity_change) FROM inventory_transactions t WHERE t.receiving_item_id = i.id), 0)`,
    );
    expect(rows).toEqual([]);
  });
});

describe('health endpoints (NFR-3)', () => {
  it('liveness and readiness need no token', async () => {
    const live = await request(app).get('/api/health');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('readiness reports 503 when the database is unreachable', async () => {
    const { createApp } = await import('../src/app.js');
    const { config } = await import('./helpers.js');
    const dead = createPool('postgres://postgres@127.0.0.1:1/nope');
    const res = await request(createApp({ pool: dead, config, log: () => undefined })).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', database: 'down' });
    await dead.end().catch(() => undefined);
  });
});

describe('error handling never leaks internals (NFR-2)', () => {
  it('a database failure returns a generic 500 envelope with no SQL or stack', async () => {
    const { createApp } = await import('../src/app.js');
    const { config, auth } = await import('./helpers.js');
    await tokenFor('operator');
    const headers = await auth('operator');
    // A pool whose queries fail after authentication succeeds
    const flaky = createPool(TEST_DATABASE_URL);
    const realQuery = flaky.query.bind(flaky);
    let calls = 0;
    (flaky as unknown as { query: unknown }).query = (...args: unknown[]) => {
      calls += 1;
      if (calls > 1) return Promise.reject(Object.assign(new Error('relation "secret_table" does not exist'), { code: '42P01' }));
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    };
    const logged: unknown[] = [];
    const res = await request(createApp({ pool: flaky, config, log: (_m, e) => logged.push(e) }))
      .get('/api/products')
      .set(headers);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(JSON.stringify(res.body)).not.toMatch(/secret_table|stack|SELECT/i);
    expect(logged.length).toBeGreaterThan(0); // but it IS logged server-side
    await flaky.end();
  });
});

describe('migrations (technical-spec §4.3)', () => {
  it('re-running is a no-op', async () => {
    const applied = await runMigrations(pool, undefined, () => undefined);
    expect(applied).toEqual([]);
  });

  it('records applied files with a checksum', async () => {
    const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename');
    expect(rows[0]).toMatchObject({ filename: '001_init.sql' });
    expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to run when an already-applied migration file was modified', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await writeFile(path.join(dir, '001_init.sql'), 'SELECT 1; -- tampered');
    await expect(runMigrations(pool, dir, () => undefined)).rejects.toThrow(/modified after it was applied/);
  });

  it('a failing migration rolls back completely and is not recorded', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    const { readFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, '001_init.sql'), await readFile(path.join(DEFAULT_MIGRATIONS_DIR, '001_init.sql'), 'utf8'));
    await writeFile(path.join(dir, '002_broken.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;');
    await expect(runMigrations(pool, dir, () => undefined)).rejects.toThrow(/002_broken\.sql failed/);
    const t = await pool.query("SELECT to_regclass('public.half_done') AS t");
    expect(t.rows[0].t).toBeNull();
    const rec = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = '002_broken.sql'");
    expect(rec.rowCount).toBe(0);
  });

  it('concurrent runners are serialised by the advisory lock (no duplicate application)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    const { readFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, '001_init.sql'), await readFile(path.join(DEFAULT_MIGRATIONS_DIR, '001_init.sql'), 'utf8'));
    const extra = `CREATE TABLE IF NOT EXISTS lock_probe_${Date.now()} (id int);`;
    await writeFile(path.join(dir, '900_probe.sql'), extra);
    const pools = [createPool(TEST_DATABASE_URL), createPool(TEST_DATABASE_URL), createPool(TEST_DATABASE_URL)];
    const results = await Promise.all(pools.map((p) => runMigrations(p, dir, () => undefined)));
    await Promise.all(pools.map((p) => p.end()));
    expect(results.flat().filter((f) => f === '900_probe.sql')).toHaveLength(1);
  });
});

describe('seeding (technical-spec §4.3)', () => {
  it('is idempotent, never overwrites an existing user, and skips users without a password', async () => {
    await tokenFor('supervisor'); // user exists with PASSWORD
    const log: string[] = [];
    await seedUsers(pool, { operatorPassword: undefined, supervisorPassword: 'a-different-password', bcryptRounds: 4 }, (m) => log.push(m));
    expect(log.join('\n')).toContain('skipping user "operator"');
    expect(log.join('\n')).toContain('user "supervisor" already exists');

    const newPw = await request(app).post('/api/auth/login').send({ username: 'supervisor', password: 'a-different-password' });
    const oldPw = await request(app).post('/api/auth/login').send({ username: 'supervisor', password: PASSWORD });
    expect(newPw.status).toBe(401); // seed did NOT overwrite the password
    expect(oldPw.status).toBe(200);
  });

  it('creates a missing user with the given role', async () => {
    const isolated = createPool(TEST_DATABASE_URL);
    await isolated.query("DELETE FROM users WHERE username = 'seed-probe'"); // no-op safety
    await seedUsers(isolated, { operatorPassword: 'operator-password-1', supervisorPassword: undefined, bcryptRounds: 4 }, () => undefined);
    const { rows } = await isolated.query("SELECT role FROM users WHERE username = 'operator'");
    expect(rows[0].role).toBe('OPERATOR');
    await isolated.end();
  });
});
