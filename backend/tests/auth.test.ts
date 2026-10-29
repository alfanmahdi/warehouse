import { afterAll, describe, expect, it } from 'vitest';
import { PASSWORD, app, auth, config, forgeToken, pool, request, tokenFor } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

describe('login (FR-AUTH-1, AC-9.1)', () => {
  it('returns a token and the user profile for valid credentials', async () => {
    await tokenFor('operator');
    const res = await request(app).post('/api/auth/login').send({ username: 'operator', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(config.JWT_EXPIRES_IN_SECONDS);
    expect(res.body.user).toMatchObject({ username: 'operator', role: 'OPERATOR' });
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2'); // no bcrypt hash leaks
  });

  it('is case-insensitive for the username', async () => {
    await tokenFor('supervisor');
    const res = await request(app).post('/api/auth/login').send({ username: ' SuperVisor ', password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('gives the SAME generic 401 for a wrong password and an unknown user (no enumeration)', async () => {
    await tokenFor('operator');
    const wrong = await request(app).post('/api/auth/login').send({ username: 'operator', password: 'nope-nope' });
    const unknown = await request(app).post('/api/auth/login').send({ username: 'ghost-user', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a deactivated user (FR-AUTH-5)', async () => {
    await tokenFor('operator');
    await pool.query(
      `INSERT INTO users (username, full_name, password_hash, role, is_active)
       SELECT 'inactive-user', 'Inactive', password_hash, 'OPERATOR', false FROM users WHERE username = 'operator'
       ON CONFLICT (username) DO NOTHING`,
    );
    const res = await request(app).post('/api/auth/login').send({ username: 'inactive-user', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it.each([{}, { username: 'a' }, { password: 'x' }, { username: 5, password: 'x' }, { username: 'a', password: '' }, { username: 'a', password: 'x', role: 'SUPERVISOR' }])(
    'returns 400 VALIDATION_ERROR for malformed body %j',
    async (body) => {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"username": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('token handling (FR-AUTH-2, AC-9.2)', () => {
  const protectedPaths = ['/api/products', '/api/receiving-documents', '/api/inventory', '/api/inventory/transactions', '/api/auth/me'];

  it.each(protectedPaths)('GET %s without a token → 401', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects garbage, wrong-scheme and foreign-secret tokens', async () => {
    expect((await request(app).get('/api/products').set('Authorization', 'Bearer not.a.jwt')).status).toBe(401);
    expect((await request(app).get('/api/products').set('Authorization', 'Basic abc')).status).toBe(401);
    await tokenFor('operator');
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM users WHERE username = 'operator'");
    const forged = forgeToken(rows[0]!.id, 'SUPERVISOR', { secret: 'a-different-secret-a-different-secret!!' });
    expect((await request(app).get('/api/products').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    await tokenFor('operator');
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM users WHERE username = 'operator'");
    const expired = forgeToken(rows[0]!.id, 'OPERATOR', { expiresIn: -10 });
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('role comes from the database, not the token: a forged SUPERVISOR claim does not elevate an operator', async () => {
    await tokenFor('operator');
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM users WHERE username = 'operator'");
    const elevated = forgeToken(rows[0]!.id, 'SUPERVISOR'); // valid signature, lying role claim
    const res = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${elevated}`)
      .send({ sku: 'ELEVATE-1', name: 'x' });
    expect(res.status).toBe(403);
  });

  it('a user deactivated after login is locked out immediately', async () => {
    await tokenFor('operator');
    const login = await request(app).post('/api/auth/login').send({ username: 'operator', password: PASSWORD });
    await pool.query("UPDATE users SET is_active = false WHERE username = 'operator'");
    try {
      const res = await request(app).get('/api/products').set('Authorization', `Bearer ${login.body.token}`);
      expect(res.status).toBe(401);
    } finally {
      await pool.query("UPDATE users SET is_active = true WHERE username = 'operator'");
    }
  });

  it('GET /auth/me returns the current user', async () => {
    const res = await request(app).get('/api/auth/me').set(await auth('supervisor'));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'supervisor', role: 'SUPERVISOR' });
  });
});

describe('authorization matrix (PRD §2.1)', () => {
  // role checks happen BEFORE validation, so an empty body is enough to prove 403 vs "reached validation"
  it('operator is forbidden on supervisor-only endpoints', async () => {
    const h = await auth('operator');
    expect((await request(app).post('/api/products').set(h).send({})).status).toBe(403);
    expect((await request(app).patch('/api/products/1').set(h).send({})).status).toBe(403);
    expect((await request(app).post('/api/receiving-documents/1/complete').set(h)).status).toBe(403);
    expect((await request(app).post('/api/receiving-documents/1/cancel').set(h)).status).toBe(403);
  });

  it('supervisor passes the role check on the same endpoints (reaches validation / lookup)', async () => {
    const h = await auth('supervisor');
    expect((await request(app).post('/api/products').set(h).send({})).status).toBe(400);
    expect((await request(app).patch('/api/products/999999').set(h).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/receiving-documents/999999/complete').set(h)).status).toBe(404);
    expect((await request(app).post('/api/receiving-documents/999999/cancel').set(h)).status).toBe(404);
  });

  it('operator can create documents and record receipts (reaches validation)', async () => {
    const h = await auth('operator');
    expect((await request(app).post('/api/receiving-documents').set(h).send({})).status).toBe(400);
    expect((await request(app).post('/api/receiving-documents/999999/receipts').set(h).send({ lines: [{ itemId: 1, quantity: 1 }] })).status).toBe(404);
  });

  it('unknown route → 404 with the error envelope', async () => {
    const res = await request(app).get('/api/nope').set(await auth('operator'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
