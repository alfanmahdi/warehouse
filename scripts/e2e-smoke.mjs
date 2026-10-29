#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING stack, through the public entry point (nginx -> api -> db).
 *
 *   node scripts/e2e-smoke.mjs                       # uses http://localhost:8080 and credentials from ./.env
 *   BASE_URL=http://localhost:3000 node scripts/e2e-smoke.mjs
 *
 * Exit code 0 = every check passed. Creates its own uniquely named data; safe to run repeatedly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
try {
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} catch { /* no .env: rely on process env */ }

const BASE = (env.BASE_URL ?? `http://localhost:${env.WEB_PORT ?? 8080}`).replace(/\/$/, '');
const creds = {
  operator: env.SEED_OPERATOR_PASSWORD,
  supervisor: env.SEED_SUPERVISOR_PASSWORD,
};
if (!creds.operator || !creds.supervisor) {
  console.error('Missing SEED_OPERATOR_PASSWORD / SEED_SUPERVISOR_PASSWORD (set them in .env or the environment).');
  process.exit(2);
}

let passed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failures.push(name); console.log(`  ✘ ${name} ${extra}`); }
}

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(username) {
  const r = await call('POST', '/api/auth/login', { body: { username, password: creds[username] } });
  if (r.status !== 200) throw new Error(`login as ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const run = Date.now().toString(36).toUpperCase();
console.log(`E2E smoke test against ${BASE}  (run id ${run})\n`);

console.log('1. Health and authentication');
const health = await call('GET', '/api/health/ready');
check('readiness endpoint is up and the database answers', health.status === 200 && health.body?.database === 'up');
check('unauthenticated request is rejected (401)', (await call('GET', '/api/products')).status === 401);
check('wrong password is rejected (401)', (await call('POST', '/api/auth/login', { body: { username: 'operator', password: 'definitely-wrong' } })).status === 401);
const op = await login('operator');
const sup = await login('supervisor');
check('both roles can log in', !!op && !!sup);

console.log('2. Products (supervisor only)');
const skuA = `E2E-A-${run}`, skuB = `E2E-B-${run}`;
check('operator cannot create a product (403)', (await call('POST', '/api/products', { token: op, body: { sku: skuA, name: 'A' } })).status === 403);
const pa = await call('POST', '/api/products', { token: sup, body: { sku: skuA, name: 'E2E Widget A' } });
const pb = await call('POST', '/api/products', { token: sup, body: { sku: skuB, name: 'E2E Widget B' } });
check('supervisor creates two products (201)', pa.status === 201 && pb.status === 201);
check('duplicate SKU (any case) is rejected (409)', (await call('POST', '/api/products', { token: sup, body: { sku: skuA.toLowerCase(), name: 'dup' } })).status === 409);

console.log('3. Receiving document');
const created = await call('POST', '/api/receiving-documents', {
  token: op,
  body: { supplierName: 'E2E Supplier', referenceNumber: `PO-${run}`, items: [{ productId: pa.body.id, expectedQuantity: 10 }, { productId: pb.body.id, expectedQuantity: 4 }] },
});
check('operator creates a document (201, status OPEN)', created.status === 201 && created.body.status === 'OPEN');
const doc = created.body;
const [itemA, itemB] = doc.items;
check('invalid expected quantity is rejected (400)', (await call('POST', '/api/receiving-documents', { token: op, body: { supplierName: 'S', items: [{ productId: pa.body.id, expectedQuantity: 0 }] } })).status === 400);

console.log('4. Partial receipt, over-receipt, atomicity');
const key = `e2e-${run}-1`;
const r1 = await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, headers: { 'Idempotency-Key': key }, body: { lines: [{ itemId: itemA.id, quantity: 4 }] } });
check('partial receipt recorded (201) → PARTIALLY_RECEIVED', r1.status === 201 && r1.body.document.status === 'PARTIALLY_RECEIVED');
check('item shows received 4 / remaining 6', r1.body.document.items[0].receivedQuantity === 4 && r1.body.document.items[0].remainingQuantity === 6);
const replay = await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, headers: { 'Idempotency-Key': key }, body: { lines: [{ itemId: itemA.id, quantity: 4 }] } });
check('replay with the same Idempotency-Key returns 200 and the same receipt', replay.status === 200 && replay.body.receipt.id === r1.body.receipt.id);
let inv = await call('GET', `/api/inventory?q=${skuA}`, { token: op });
check('stock increased exactly once (4), not twice', inv.body.data[0]?.quantityOnHand === 4);

const over = await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: 7 }] } });
check('over-receipt (7 > 6 remaining) rejected: 422 OVER_RECEIPT', over.status === 422 && over.body.error.code === 'OVER_RECEIPT');
const atomic = await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: 1 }, { itemId: itemB.id, quantity: 5 }] } });
check('multi-line request with one bad line is rejected as a whole (422)', atomic.status === 422);
inv = await call('GET', `/api/inventory?q=${skuA}`, { token: op });
const invB0 = await call('GET', `/api/inventory?q=${skuB}`, { token: op });
check('after rejections stock is unchanged (A=4, B=0)', inv.body.data[0]?.quantityOnHand === 4 && invB0.body.data[0]?.quantityOnHand === 0);
check('non-integer and string quantities are rejected (400)',
  (await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: 2.5 }] } })).status === 400 &&
  (await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: '2' }] } })).status === 400);

console.log('5. Completion rules');
check('operator cannot complete (403)', (await call('POST', `/api/receiving-documents/${doc.id}/complete`, { token: op })).status === 403);
const early = await call('POST', `/api/receiving-documents/${doc.id}/complete`, { token: sup });
check('supervisor cannot complete while items are open (422 NOT_FULLY_RECEIVED)', early.status === 422 && early.body.error.code === 'NOT_FULLY_RECEIVED');
check('cannot cancel a partially received document (409)', (await call('POST', `/api/receiving-documents/${doc.id}/cancel`, { token: sup })).status === 409);

const rest = await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: 6 }, { itemId: itemB.id, quantity: 4 }] } });
check('receiving the rest → FULLY_RECEIVED', rest.status === 201 && rest.body.document.status === 'FULLY_RECEIVED');
check('receipt on a fully received document is rejected (409 INVALID_STATE)',
  (await call('POST', `/api/receiving-documents/${doc.id}/receipts`, { token: op, body: { lines: [{ itemId: itemA.id, quantity: 1 }] } })).status === 409);
const done = await call('POST', `/api/receiving-documents/${doc.id}/complete`, { token: sup });
check('supervisor completes the document → COMPLETED', done.status === 200 && done.body.status === 'COMPLETED');
check('completing again is rejected (409)', (await call('POST', `/api/receiving-documents/${doc.id}/complete`, { token: sup })).status === 409);

console.log('6. Inventory and history');
const invA = await call('GET', `/api/inventory?q=${skuA}`, { token: op });
const invB = await call('GET', `/api/inventory?q=${skuB}`, { token: op });
check('inventory A = 10, B = 4', invA.body.data[0]?.quantityOnHand === 10 && invB.body.data[0]?.quantityOnHand === 4);
const hist = await call('GET', `/api/inventory/transactions?productId=${pa.body.id}`, { token: op });
check('history for A has 2 entries, newest first (+6 then +4), balances 10 and 4',
  hist.body.total === 2 && hist.body.data[0].quantityChange === 6 && hist.body.data[0].balanceAfter === 10 && hist.body.data[1].balanceAfter === 4);
const sum = hist.body.data.reduce((n, t) => n + t.quantityChange, 0);
check('on_hand equals the sum of the ledger', sum === invA.body.data[0].quantityOnHand);

console.log('7. Concurrency through the real stack');
const docC = (await call('POST', '/api/receiving-documents', { token: op, body: { supplierName: 'Race', items: [{ productId: pa.body.id, expectedQuantity: 5 }] } })).body;
const results = await Promise.all(Array.from({ length: 12 }, () => call('POST', `/api/receiving-documents/${docC.id}/receipts`, { token: op, body: { lines: [{ itemId: docC.items[0].id, quantity: 1 }] } })));
check('12 parallel receipts of 1 against 5 remaining: exactly 5 succeed', results.filter((r) => r.status === 201).length === 5);
const after = (await call('GET', `/api/receiving-documents/${docC.id}`, { token: op })).body;
check('document ends at received 5 / expected 5', after.items[0].receivedQuantity === 5 && after.status === 'FULLY_RECEIVED');
const invFinal = await call('GET', `/api/inventory?q=${skuA}`, { token: op });
check('inventory A = 15 (10 + 5), no over-count', invFinal.body.data[0]?.quantityOnHand === 15);

console.log('8. Cancellation');
const docX = (await call('POST', '/api/receiving-documents', { token: op, body: { supplierName: 'Cancel me', items: [{ productId: pb.body.id, expectedQuantity: 1 }] } })).body;
check('supervisor cancels an untouched document', (await call('POST', `/api/receiving-documents/${docX.id}/cancel`, { token: sup })).body?.status === 'CANCELLED');
check('cancelled document accepts no receipts (409)', (await call('POST', `/api/receiving-documents/${docX.id}/receipts`, { token: op, body: { lines: [{ itemId: docX.items[0].id, quantity: 1 }] } })).status === 409);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
