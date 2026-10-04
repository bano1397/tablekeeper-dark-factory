'use strict';
// Behaviour tests for stage 1 rules beyond the shipped smoke checks.
// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');

let base;
const server = createServer();
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  resolve();
})));
test.after(() => new Promise((resolve) => server.close(resolve)));

let keySeq = 0;
const newKey = () => `k-${process.pid}-${++keySeq}`;

async function call(method, path, { body, raw, token, key, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (key !== undefined) h['Idempotency-Key'] = key;
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) payload = JSON.stringify(body);
  if (payload !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function expectError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code, JSON.stringify(res.body));
  assert.equal(typeof res.body.error.message, 'string');
}

const ALL_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hours = (opens = '18:00', closes = '23:00') => ALL_WEEK.map((weekday) => ({ weekday, opens, closes }));
const restaurant = (over = {}) => ({
  id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 30,
  reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120, opening_hours: hours(),
  tables: [{ id: 't_1', label: '1', capacity: 2 }, { id: 't_2', label: '2', capacity: 4 },
    { id: 't_3', label: '3', capacity: 6 }],
  ...over,
});
const ADA = { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' };
const BOB = { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob' };

function futureDate(days = 7) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function world(fixture = {}) {
  const res = await call('POST', '/_test/reset', {
    body: { users: [ADA, BOB], restaurants: [restaurant()], reservations: [], ...fixture },
  });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const ada = (await call('POST', '/auth/login', { body: { email: ADA.email, password: ADA.password } })).body.token;
  const bob = (await call('POST', '/auth/login', { body: { email: BOB.email, password: BOB.password } })).body.token;
  return { ada, bob, date: futureDate() };
}

const book = (token, over = {}, key = newKey()) => call('POST', '/reservations', {
  token, key,
  body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${futureDate()}T19:00`, party_size: 4, ...over },
});

// ---- time zones ------------------------------------------------------------------

test('New York spring-forward hour is skipped and unbookable', async () => {
  const { ada } = await world({ restaurants: [restaurant({ id: 'r_ny', timezone: 'America/New_York', opening_hours: hours('00:00', '23:30') })] });
  const slots = (await call('GET', '/availability?restaurant_id=r_ny&date=2026-03-08&party_size=2')).body.slots;
  const times = slots.map((s) => s.starts_at_local.slice(11));
  assert.ok(!times.includes('02:00') && !times.includes('02:30'));
  assert.ok(times.includes('01:30') && times.includes('03:00'));
  assert.ok(slots.find((s) => s.starts_at_local.endsWith('01:30')).starts_at.endsWith('-05:00'));
  assert.ok(slots.find((s) => s.starts_at_local.endsWith('03:00')).starts_at.endsWith('-04:00'));
  expectError(await book(ada, { restaurant_id: 'r_ny', starts_at_local: '2026-03-08T02:30' }), 422, 'invalid_local_time');
});

test('New York fall-back resolves to the first occurrence (-04:00)', async () => {
  const { ada } = await world({ restaurants: [restaurant({ id: 'r_ny', timezone: 'America/New_York', opening_hours: hours('00:00', '23:30') })] });
  const times = (await call('GET', '/availability?restaurant_id=r_ny&date=2026-11-01&party_size=2')).body.slots
    .map((s) => s.starts_at_local.slice(11));
  assert.equal(times.filter((t) => t === '01:00').length, 1);
  assert.equal(times.filter((t) => t === '01:30').length, 1);
  const res = await book(ada, { restaurant_id: 'r_ny', starts_at_local: '2026-11-01T01:00' });
  assert.equal(res.status, 201);
  assert.equal(res.body.starts_at, '2026-11-01T01:00:00-04:00');
  // 90 absolute minutes from 01:00 EDT is 01:30 EST.
  assert.equal(res.body.ends_at, '2026-11-01T01:30:00-05:00');
});

test('fall-back absolute duration blocks the right slots on the repeated hour', async () => {
  const { ada } = await world({ restaurants: [restaurant({ opening_hours: hours('00:00', '23:30') })] });
  // 01:30 CEST + 90 min = 02:00 CET; it occupies the whole first 02:xx hour (CEST).
  assert.equal((await book(ada, { starts_at_local: '2026-10-25T01:30' })).status, 201);
  const slots = (await call('GET', '/availability?restaurant_id=r_anker&date=2026-10-25&party_size=4')).body.slots;
  const at = (t) => slots.find((s) => s.starts_at_local.endsWith(t)).available_table_ids;
  assert.ok(!at('02:00').includes('t_2')); // 02:00 CEST is inside the booking
  assert.ok(!at('02:30').includes('t_2'));
  assert.ok(at('03:00').includes('t_2')); // 03:00 CET is after 02:00 CET
});

test('Berlin spring-forward slots are missing from availability', async () => {
  await world({ restaurants: [restaurant({ opening_hours: hours('00:00', '23:30') })] });
  const times = (await call('GET', '/availability?restaurant_id=r_anker&date=2026-03-29&party_size=2')).body.slots
    .map((s) => s.starts_at_local.slice(11));
  assert.ok(!times.includes('02:00') && !times.includes('02:30'));
  assert.equal(new Set(times).size, times.length);
});

// ---- validation -----------------------------------------------------------------

test('wrong JSON types are 400, missing fields 422', async () => {
  const { ada } = await world();
  expectError(await book(ada, { table_id: 7 }), 400, 'malformed_request');
  expectError(await book(ada, { restaurant_id: null }), 400, 'malformed_request');
  expectError(await book(ada, { starts_at_local: 1900 }), 400, 'malformed_request');
  expectError(await book(ada, { party_size: true }), 422, 'validation_failed');
  const body = { restaurant_id: 'r_anker', starts_at_local: `${futureDate()}T19:00`, party_size: 4 };
  expectError(await call('POST', '/reservations', { token: ada, key: newKey(), body }), 422, 'validation_failed');
  expectError(await call('POST', '/reservations', { token: ada, key: newKey(), raw: '[1,2]' }), 400, 'malformed_request');
  expectError(await book(ada, { table_id: 'x'.repeat(65) }), 422, 'validation_failed');
});

test('idempotency key length and presence', async () => {
  const { ada } = await world();
  expectError(await book(ada, {}, ''), 400, 'missing_idempotency_key');
  expectError(await book(ada, {}, 'k'.repeat(256)), 422, 'validation_failed');
  assert.equal((await book(ada, {}, 'k'.repeat(255))).status, 201);
});

test('availability rejects non-decimal integers and bad ids', async () => {
  await world();
  for (const p of ['1e9', '4.0', '+4', '', '-0']) {
    expectError(await call('GET', `/availability?restaurant_id=r_anker&date=${futureDate()}&party_size=${encodeURIComponent(p)}`), 422, 'validation_failed');
  }
});

test('signup validation and login', async () => {
  await world();
  expectError(await call('POST', '/auth/signup', { body: { email: 'ADA@example.com', password: 'longenough', display_name: 'A' } }), 409, 'email_taken');
  expectError(await call('POST', '/auth/signup', { body: { email: 'x@y', password: 'longenough' } }), 422, 'validation_failed');
  expectError(await call('POST', '/auth/signup', { raw: '{bad' }), 400, 'malformed_request');
  const made = await call('POST', '/auth/signup', { body: { email: 'new@example.com', password: 'longenough', display_name: 'N' } });
  assert.equal(made.status, 201);
  const again = await call('POST', '/auth/login', { body: { email: 'new@example.com', password: 'longenough' } });
  assert.equal(again.status, 200);
  assert.equal(again.body.user_id, made.body.user_id);
  assert.notEqual(again.body.token, made.body.token);
  // Both tokens stay valid.
  assert.equal((await call('GET', '/reservations', { token: made.body.token })).status, 200);
  assert.equal((await call('GET', '/reservations', { token: again.body.token })).status, 200);
  expectError(await call('GET', '/reservations', { headers: { Authorization: 'Basic abc' } }), 401, 'unauthenticated');
});

test('passwords are not stored in plaintext', async () => {
  await world();
  const exported = JSON.stringify((await call('GET', '/_test/export')).body);
  assert.ok(!exported.includes('correct horse'));
});

// ---- idempotency ----------------------------------------------------------------

test('reuse with a different (even invalid) body is 409 before validation', async () => {
  const { ada } = await world();
  const key = newKey();
  assert.equal((await book(ada, {}, key)).status, 201);
  expectError(await call('POST', '/reservations', { token: ada, key, body: { party_size: 'nope' } }), 409, 'idempotency_key_reuse');
});

test('same key and body on a different path is not a replay', async () => {
  const { ada } = await world();
  const key = newKey();
  const created = await book(ada, { table_id: 't_1', party_size: 2 }, key);
  assert.equal(created.status, 201);
  const body = { moves: [{ reference: created.body.reference, table_id: 't_3' }] };
  assert.equal((await call('POST', '/reservation-moves', { token: ada, key, body })).status, 201);
});

test('key reused after a 4xx is a first use', async () => {
  const { ada } = await world();
  const key = newKey();
  expectError(await book(ada, { starts_at_local: `${futureDate()}T19:15` }, key), 422, 'not_on_slot_grid');
  assert.equal((await book(ada, {}, key)).status, 201);
});

test('replay ignores key order and whitespace', async () => {
  const { ada } = await world();
  const key = newKey();
  const first = await book(ada, {}, key);
  const raw = `{ "party_size": 4, "starts_at_local": "${futureDate()}T19:00",\n "table_id":"t_2", "restaurant_id": "r_anker" }`;
  const replay = await call('POST', '/reservations', { token: ada, key, raw });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
});

test('twenty concurrent identical requests: one 201, the rest 200, one booking', async () => {
  const { ada } = await world();
  const key = newKey();
  const out = await Promise.all(Array.from({ length: 20 }, () => book(ada, {}, key)));
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.equal(out.filter((r) => r.status === 200).length, 19);
  for (const r of out) assert.deepEqual(r.body, out[0].body);
  assert.equal((await call('GET', '/reservations', { token: ada })).body.reservations.length, 1);
});

test('fifty racers for one table: exactly one wins', async () => {
  const { ada, bob } = await world();
  const out = await Promise.all(Array.from({ length: 50 }, (_, i) => book(i % 2 ? ada : bob)));
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.equal(out.filter((r) => r.status === 409).length, 49);
});

// ---- cancel and amend -------------------------------------------------------------

test('failed PATCH leaves the booking and its occupancy unchanged', async () => {
  const { ada } = await world();
  const date = futureDate();
  await book(ada, { table_id: 't_3', starts_at_local: `${date}T20:00` });
  const mine = (await book(ada)).body;
  expectError(await call('PATCH', `/reservations/${mine.reference}`, { token: ada, body: { table_id: 't_3' } }), 409, 'table_unavailable');
  const after = (await call('GET', `/reservations/${mine.reference}`, { token: ada })).body;
  assert.deepEqual(after, mine);
  expectError(await book(ada), 409, 'table_unavailable');
});

test('PATCH may overlap its own old interval', async () => {
  const { ada } = await world();
  const ref = (await book(ada)).body.reference;
  const res = await call('PATCH', `/reservations/${ref}`, { token: ada, body: { starts_at_local: `${futureDate()}T19:30` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ends_at.slice(11, 16), '21:00');
});

// ---- moves -----------------------------------------------------------------------

test('moves swap two tables atomically', async () => {
  const { ada } = await world();
  const a = (await book(ada, { table_id: 't_2', party_size: 2 })).body;
  const b = (await book(ada, { table_id: 't_3', party_size: 2 })).body;
  const res = await call('POST', '/reservation-moves', {
    token: ada, key: newKey(),
    body: { moves: [{ reference: a.reference, table_id: 't_3' }, { reference: b.reference, table_id: 't_2' }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.reservations.map((r) => r.table_id), ['t_3', 't_2']);
  assert.equal(res.body.reservations[0].reservation_id, a.reservation_id);
  assert.equal(res.body.reservations[0].created_at, a.created_at);
});

test('a failing move changes nothing', async () => {
  const { ada, bob } = await world();
  const a = (await book(ada, { table_id: 't_1', party_size: 2 })).body;
  const b = (await book(ada, { table_id: 't_2', party_size: 2, starts_at_local: `${futureDate()}T21:00` })).body;
  await book(bob, { table_id: 't_3' });
  const key = newKey();
  const moves = { moves: [{ reference: a.reference, table_id: 't_2' }, { reference: b.reference, table_id: 't_3', starts_at_local: `${futureDate()}T19:30` }] };
  expectError(await call('POST', '/reservation-moves', { token: ada, key, body: moves }), 409, 'table_unavailable');
  assert.deepEqual((await call('GET', `/reservations/${a.reference}`, { token: ada })).body, a);
  assert.deepEqual((await call('GET', `/reservations/${b.reference}`, { token: ada })).body, b);
  // The failed key stays reusable for a different, valid batch.
  const ok = { moves: [{ reference: a.reference, table_id: 't_2' }] };
  assert.equal((await call('POST', '/reservation-moves', { token: ada, key, body: ok })).status, 201);
});

test('moves validation codes', async () => {
  const { ada, bob } = await world({
    restaurants: [restaurant(), restaurant({ id: 'r_two', name: 'Two' })],
  });
  const a = (await book(ada)).body;
  const other = (await book(ada, { restaurant_id: 'r_two' })).body;
  const bobs = (await book(bob, { table_id: 't_3' })).body;
  const mv = (moves, token = ada) => call('POST', '/reservation-moves', { token, key: newKey(), body: { moves } });
  expectError(await mv([]), 422, 'validation_failed');
  expectError(await mv(Array.from({ length: 9 }, () => ({ reference: a.reference }))), 422, 'validation_failed');
  expectError(await mv([{ reference: a.reference }, { reference: a.reference }]), 422, 'validation_failed');
  expectError(await mv([{ table_id: 't_1' }]), 422, 'validation_failed');
  expectError(await mv([{ reference: bobs.reference }]), 404, 'not_found');
  expectError(await mv([{ reference: a.reference }, { reference: other.reference }]), 422, 'validation_failed');
  expectError(await call('POST', '/reservation-moves', { key: newKey(), body: { moves: [{ reference: a.reference }] } }), 401, 'unauthenticated');
  expectError(await call('POST', '/reservation-moves', { token: ada, body: { moves: [{ reference: a.reference }] } }), 400, 'missing_idempotency_key');
  await call('POST', `/reservations/${a.reference}/cancel`, { token: ada });
  expectError(await mv([{ reference: a.reference, party_size: 2 }]), 409, 'reservation_cancelled');
});

test('move replay returns the original response after later changes', async () => {
  const { ada } = await world();
  const a = (await book(ada, { table_id: 't_2' })).body;
  const key = newKey();
  const body = { moves: [{ reference: a.reference, table_id: 't_3' }] };
  const first = await call('POST', '/reservation-moves', { token: ada, key, body });
  assert.equal(first.status, 201);
  await call('POST', `/reservations/${a.reference}/cancel`, { token: ada });
  const replay = await call('POST', '/reservation-moves', { token: ada, key, body });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
});

// ---- export / import --------------------------------------------------------------

test('export/import preserves tokens, receipts and replays; rejects bad documents', async () => {
  const { ada } = await world();
  const key = newKey();
  const created = await book(ada, {}, key);
  const snapshot = (await call('GET', '/_test/export')).body;
  assert.equal(snapshot.track, 'tablekeeper');
  assert.equal(snapshot.format_version, 1);
  await book(ada, { table_id: 't_3' }); // later write is not in the snapshot
  await world();
  assert.equal((await call('POST', '/_test/import', { body: snapshot })).status, 204);
  assert.equal((await call('POST', '/_test/import', { body: snapshot })).status, 204);
  // The pre-reset token still works and the replay still returns the original receipt.
  const replay = await book(ada, {}, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  assert.equal((await call('GET', '/reservations', { token: ada })).body.reservations.length, 1);
  // Login with the hashed password still works.
  assert.equal((await call('POST', '/auth/login', { body: { email: ADA.email, password: ADA.password } })).status, 200);

  for (const bad of [{ ...snapshot, track: 'pocketful' }, { ...snapshot, format_version: 2 },
    { track: 'tablekeeper', format_version: 1 }, { ...snapshot, state: { users: 'x' } }]) {
    expectError(await call('POST', '/_test/import', { body: bad }), 422, 'validation_failed');
  }
  expectError(await call('POST', '/_test/import', { raw: '{nope' }), 400, 'malformed_request');
  // Still the imported state after the rejected imports.
  assert.equal((await call('GET', `/reservations/${created.body.reference}`, { token: ada })).status, 200);
});

test('reset clears imported state and tokens', async () => {
  const { ada } = await world();
  await world();
  expectError(await call('GET', '/reservations', { token: ada }), 401, 'unauthenticated');
});

// ---- fixtures ---------------------------------------------------------------------

test('reset rejects invalid fixtures and overlapping seeds', async () => {
  const date = futureDate();
  const seed = (ref, at) => ({ id: `id_${ref}`, reference: ref, user_id: 'u_ada', restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${date}T${at}`, party_size: 2 });
  expectError(await call('POST', '/_test/reset', { body: { users: [ADA], restaurants: [restaurant()], reservations: [seed('SEED01', '19:00'), seed('SEED02', '20:00')] } }), 422, 'validation_failed');
  expectError(await call('POST', '/_test/reset', { body: { users: [], restaurants: [restaurant({ timezone: 'Mars/Base' })] } }), 422, 'validation_failed');
  expectError(await call('POST', '/_test/reset', { body: { users: [], restaurants: [restaurant({ id: 'r'.repeat(65) })] } }), 422, 'validation_failed');
  assert.equal((await call('POST', '/_test/reset', { body: { users: [ADA], restaurants: [restaurant()], reservations: [seed('SEED01', '19:00'), seed('SEED02', '20:30')] } })).status, 204);
});

test('past bookings are allowed but cannot be cancelled or changed', async () => {
  const { ada } = await world();
  const res = await book(ada, { starts_at_local: '2020-01-02T19:00' });
  assert.equal(res.status, 201);
  expectError(await call('POST', `/reservations/${res.body.reference}/cancel`, { token: ada }), 409, 'cutoff_passed');
  expectError(await call('PATCH', `/reservations/${res.body.reference}`, { token: ada, body: { party_size: 2 } }), 409, 'cutoff_passed');
});

test('unknown routes and the error envelope', async () => {
  await world();
  expectError(await call('GET', '/nope'), 404, 'not_found');
  const health = await call('GET', '/health');
  assert.deepEqual(health.body, { status: 'ok' });
});

// ---- auditor gap list: concurrency, no-op moves, import replacement ------------------

test('concurrent cancel-and-rebook of one table ends with one confirmed booking', async () => {
  const { ada, bob } = await world();
  const ref = (await book(ada)).body.reference;
  const out = await Promise.all([
    call('POST', `/reservations/${ref}/cancel`, { token: ada }),
    ...Array.from({ length: 30 }, (_, i) => book(i % 2 ? ada : bob)),
  ]);
  assert.ok(out.every((r) => r.status < 500));
  const slots = (await call('GET', `/availability?restaurant_id=r_anker&date=${futureDate()}&party_size=4`)).body.slots;
  assert.ok(!slots.find((s) => s.starts_at_local.endsWith('19:00')).available_table_ids.includes('t_2'));
  const all = [...(await call('GET', '/reservations', { token: ada })).body.reservations,
    ...(await call('GET', '/reservations', { token: bob })).body.reservations];
  assert.equal(all.filter((r) => r.status === 'confirmed' && r.table_id === 't_2').length, 1);
});

test('concurrent PATCHes onto one free table: exactly one wins', async () => {
  const { ada } = await world({
    restaurants: [restaurant({ tables: Array.from({ length: 12 }, (_, i) => ({ id: `t_${i}`, label: `${i}`, capacity: 4 })) })],
  });
  const refs = [];
  for (let i = 1; i < 12; i++) refs.push((await book(ada, { table_id: `t_${i}` })).body.reference);
  const out = await Promise.all(refs.map((ref) => call('PATCH', `/reservations/${ref}`, { token: ada, body: { table_id: 't_0' } })));
  assert.equal(out.filter((r) => r.status === 200).length, 1);
  assert.equal(out.filter((r) => r.status === 409 && r.body.error.code === 'table_unavailable').length, 10);
});

test('moves: unchanged and no-op items are returned unchanged, unknown fields ignored', async () => {
  const { ada } = await world();
  const a = (await book(ada, { table_id: 't_1', party_size: 2 })).body;
  const b = (await book(ada, { table_id: 't_2', party_size: 2 })).body;
  const res = await call('POST', '/reservation-moves', {
    token: ada, key: newKey(),
    body: { moves: [{ reference: b.reference, souvenir: 1 }, { reference: a.reference, party_size: 1, extra: 'x' }] },
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.reservations[0], b);
  assert.deepEqual(res.body.reservations[1], { ...a, party_size: 1, revision: 2 }); // stage 3: a real change bumps revision
});

test('moves: cutoff error of an earlier item wins over a later item', async () => {
  const { ada } = await world();
  const past = (await book(ada, { starts_at_local: '2020-01-02T19:00' })).body;
  const fresh = (await book(ada, { table_id: 't_3' })).body;
  const res = await call('POST', '/reservation-moves', {
    token: ada, key: newKey(),
    body: { moves: [{ reference: past.reference, table_id: 't_1' }, { reference: fresh.reference, starts_at_local: `${futureDate()}T19:15` }] },
  });
  expectError(res, 409, 'cutoff_passed');
});

test('import replaces destination users and keeps move receipts', async () => {
  const { ada } = await world();
  const a = (await book(ada, { table_id: 't_2' })).body;
  const key = newKey();
  const body = { moves: [{ reference: a.reference, table_id: 't_3' }] };
  const first = await call('POST', '/reservation-moves', { token: ada, key, body });
  const snapshot = (await call('GET', '/_test/export')).body;
  await call('POST', '/_test/reset', { body: { users: [{ id: 'u_z', email: 'z@example.com', password: 'zzzzzzzz', display_name: 'Z' }], restaurants: [] } });
  const zTok = (await call('POST', '/auth/login', { body: { email: 'z@example.com', password: 'zzzzzzzz' } })).body.token;
  assert.equal((await call('POST', '/_test/import', { body: snapshot })).status, 204);
  expectError(await call('GET', '/reservations', { token: zTok }), 401, 'unauthenticated');
  expectError(await call('POST', '/auth/login', { body: { email: 'z@example.com', password: 'zzzzzzzz' } }), 401, 'unauthenticated');
  const replay = await call('POST', '/reservation-moves', { token: ada, key, body });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal((await call('GET', `/reservations/${a.reference}`, { token: ada })).body.table_id, 't_3');
});
