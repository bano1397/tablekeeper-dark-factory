'use strict';
// Stage 2 API: combined tables, table_ids, stage-1 import compatibility, reset ordering.
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
const newKey = () => `c-${process.pid}-${++keySeq}`;

async function call(method, path, { body, raw, token, key } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, type: res.headers.get('content-type') };
}

function expectError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code, JSON.stringify(res.body));
}

const ALL_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, opens: '18:00', closes: '23:00' }));
const restaurant = (over = {}) => ({
  id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 30,
  reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120, opening_hours: ALL_WEEK,
  tables: [{ id: 't_1', label: '1', capacity: 2 }, { id: 't_2', label: '2', capacity: 4 },
    { id: 't_3', label: '3', capacity: 6 }, { id: 't_4', label: '4', capacity: 2 }],
  combinable: [['t_1', 't_2'], ['t_2', 't_3']],
  ...over,
});
const ADA = { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' };
const BOB = { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob' };
const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

async function world(fixture = {}) {
  const res = await call('POST', '/_test/reset', { body: { users: [ADA, BOB], restaurants: [restaurant()], ...fixture } });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const login = async (u) => (await call('POST', '/auth/login', { body: { email: u.email, password: u.password } })).body.token;
  return { ada: await login(ADA), bob: await login(BOB) };
}

const book = (token, over = {}, key = newKey()) => call('POST', '/reservations', {
  token, key, body: { restaurant_id: 'r_anker', starts_at_local: `${date}T19:00`, party_size: 2, ...over },
});
const slotAt = async (party, time = '19:00') => (await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=${party}`))
  .body.slots.find((s) => s.starts_at_local.endsWith(time));

test('available_options: singles in fixture order, then pairs in combinable order', async () => {
  await world();
  const slot = await slotAt(4);
  assert.deepEqual(slot.available_table_ids, ['t_2', 't_3']);
  assert.deepEqual(slot.available_options, [
    { table_ids: ['t_2'], capacity: 4 }, { table_ids: ['t_3'], capacity: 6 },
    { table_ids: ['t_1', 't_2'], capacity: 6 }, { table_ids: ['t_2', 't_3'], capacity: 10 },
  ]);
  const big = await slotAt(8);
  assert.deepEqual(big.available_table_ids, []);
  assert.deepEqual(big.available_options, [{ table_ids: ['t_2', 't_3'], capacity: 10 }]);
});

test('a combination occupies both tables; any overlapping member blocks it', async () => {
  const { ada, bob } = await world();
  const res = await book(ada, { table_ids: ['t_2', 't_1'], party_size: 6 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.table_ids, ['t_1', 't_2']); // declared order
  assert.equal(res.body.table_id, undefined);
  const slot = await slotAt(2, '20:00');
  assert.ok(!slot.available_table_ids.includes('t_1') && !slot.available_table_ids.includes('t_2'));
  assert.ok(!slot.available_options.some((o) => o.table_ids.includes('t_2')));
  expectError(await book(bob, { table_id: 't_1', starts_at_local: `${date}T20:00` }), 409, 'table_unavailable');
  expectError(await book(bob, { table_ids: ['t_2', 't_3'], party_size: 8 }), 409, 'table_unavailable');
  assert.equal((await book(bob, { table_id: 't_3' })).status, 201);
});

test('single-table responses carry table_id and table_ids', async () => {
  const { ada } = await world();
  const res = await book(ada, { table_ids: ['t_4'] });
  assert.equal(res.status, 201);
  assert.equal(res.body.table_id, 't_4');
  assert.deepEqual(res.body.table_ids, ['t_4']);
});

test('table set validation codes', async () => {
  const { ada } = await world();
  expectError(await book(ada, { table_id: 't_1', table_ids: ['t_1'] }), 422, 'validation_failed');
  expectError(await book(ada, { table_ids: ['t_1', 't_3'], party_size: 6 }), 422, 'combination_not_allowed'); // not transitive
  expectError(await book(ada, { table_ids: ['t_1', 't_2', 't_3'], party_size: 6 }), 422, 'combination_not_allowed');
  expectError(await book(ada, { table_ids: ['t_1', 't_1'] }), 422, 'validation_failed');
  expectError(await book(ada, { table_ids: [] }), 422, 'validation_failed');
  expectError(await book(ada, { table_ids: 't_1' }), 400, 'malformed_request');
  expectError(await book(ada, { table_ids: ['t_1', 7] }), 400, 'malformed_request');
  expectError(await book(ada, { table_ids: ['t_1', 't_nope'] }), 404, 'not_found');
  expectError(await book(ada, { table_ids: ['t_1', 't_2'], party_size: 7 }), 422, 'party_exceeds_capacity');
  expectError(await book(ada, {}), 422, 'validation_failed');
});

test('PATCH accepts table_ids; cancel frees every table', async () => {
  const { ada } = await world();
  const r = (await book(ada, { table_id: 't_1' })).body;
  const patched = await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { table_ids: ['t_1', 't_2'], party_size: 5 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.table_ids, ['t_1', 't_2']);
  assert.equal(patched.body.table_id, undefined);
  expectError(await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { table_ids: ['t_2'] } }), 422, 'party_exceeds_capacity');
  expectError(await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { table_ids: ['t_1', 't_4'] } }), 422, 'combination_not_allowed');
  expectError(await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { table_id: 't_3', table_ids: ['t_3'] } }), 422, 'validation_failed');
  assert.equal((await call('POST', `/reservations/${r.reference}/cancel`, { token: ada })).status, 200);
  const slot = await slotAt(2);
  assert.ok(slot.available_table_ids.includes('t_1') && slot.available_table_ids.includes('t_2'));
});

test('moves accept table_ids and keep resulting bookings disjoint', async () => {
  const { ada } = await world();
  const a = (await book(ada, { table_id: 't_1' })).body;
  const b = (await book(ada, { table_id: 't_3', party_size: 4 })).body;
  expectError(await call('POST', '/reservation-moves', {
    token: ada, key: newKey(),
    body: { moves: [{ reference: a.reference, table_ids: ['t_1', 't_2'] }, { reference: b.reference, table_ids: ['t_2', 't_3'] }] },
  }), 409, 'table_unavailable');
  const ok = await call('POST', '/reservation-moves', {
    token: ada, key: newKey(),
    body: { moves: [{ reference: b.reference, table_id: 't_4', party_size: 2 }, { reference: a.reference, table_ids: ['t_2', 't_3'] }] },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.reservations.map((r) => r.table_ids), [['t_4'], ['t_2', 't_3']]);
});

test('combination bookings under concurrency: one winner per contested table', async () => {
  const { ada, bob } = await world();
  const contenders = [
    ...Array.from({ length: 10 }, (_, i) => book(i % 2 ? ada : bob, { table_ids: ['t_1', 't_2'], party_size: 5 })),
    ...Array.from({ length: 10 }, (_, i) => book(i % 2 ? ada : bob, { table_ids: ['t_2', 't_3'], party_size: 8 })),
    ...Array.from({ length: 10 }, (_, i) => book(i % 2 ? ada : bob, { table_id: 't_2' })),
  ];
  const out = await Promise.all(contenders);
  assert.equal(out.filter((r) => r.status === 201).length, 1);
  assert.ok(out.every((r) => r.status === 201 || r.status === 409));
});

test('seeded reservations may use table_ids and cancelled status', async () => {
  const seed = (id, ref, ids, status) => ({ id, reference: ref, user_id: 'u_ada', restaurant_id: 'r_anker', table_ids: ids, starts_at_local: `${date}T19:00`, party_size: 2, ...(status ? { status } : {}) });
  await world({ reservations: [seed('a', 'SEED01', ['t_1', 't_2']), seed('b', 'SEED02', ['t_2', 't_3'], 'cancelled')] });
  const slot = await slotAt(2);
  assert.deepEqual(slot.available_table_ids, ['t_3', 't_4']);
  const bad = await call('POST', '/_test/reset', { body: { users: [ADA], restaurants: [restaurant()], reservations: [seed('a', 'SEED01', ['t_1', 't_3'])] } });
  expectError(bad, 422, 'validation_failed');
  const badPair = await call('POST', '/_test/reset', { body: { users: [], restaurants: [restaurant({ combinable: [['t_1', 't_9']] })] } });
  expectError(badPair, 422, 'validation_failed');
});

test('restaurant detail includes combinable', async () => {
  await world();
  const res = await call('GET', '/restaurants/r_anker');
  assert.deepEqual(res.body.combinable, [['t_1', 't_2'], ['t_2', 't_3']]);
});

test('imports a stage-1 export: tokens, references and replays keep working', async () => {
  const { ada } = await world();
  const stage1Receipt = {
    reservation_id: 'res_old', reference: 'OLD123', restaurant_id: 'r_anker', table_id: 't_2', party_size: 2,
    status: 'confirmed', starts_at_local: `${date}T19:00`, starts_at: `${date}T19:00:00+02:00`,
    ends_at: `${date}T20:30:00+02:00`, created_at: '2026-01-01T10:00:00+00:00',
  };
  const exported = (await call('GET', '/_test/export')).body;
  const userId = exported.state.users.find((u) => u.email === ADA.email).id;
  const startMs = Date.parse(stage1Receipt.starts_at);
  const body = { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${date}T19:00`, party_size: 2 };
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(body).sort()));
  const stage1 = {
    track: 'tablekeeper', format_version: 1,
    state: {
      users: exported.state.users, tokens: exported.state.tokens,
      restaurants: [{ ...restaurant(), combinable: undefined }],
      reservations: [{ ...stage1Receipt, user_id: userId, start_ms: startMs, end_ms: startMs + 90 * 60000 }],
      idempotency: [{ user_id: userId, method: 'POST', path: '/reservations', key: 'lost-key', fingerprint: canonical, response: stage1Receipt }],
    },
  };
  delete stage1.state.restaurants[0].combinable;
  await world();
  assert.equal((await call('POST', '/_test/import', { body: stage1 })).status, 204);
  const got = await call('GET', '/reservations/OLD123', { token: ada });
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.table_ids, ['t_2']);
  const replay = await book(ada, { table_id: 't_2' }, 'lost-key');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, stage1Receipt);
  expectError(await book(ada, { table_id: 't_2', starts_at_local: `${date}T19:30` }), 409, 'table_unavailable');
});

test('the last reset to arrive wins even if an earlier one finishes later', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.com`, password: 'correct horse', display_name: `U${i}` }));
  const slow = call('POST', '/_test/reset', { body: { users: many, restaurants: [restaurant({ id: 'r_slow', name: 'Slow' })] } });
  await new Promise((r) => setTimeout(r, 5));
  const fast = call('POST', '/_test/reset', { body: { users: [], restaurants: [restaurant({ id: 'r_fast', name: 'Fast' })] } });
  await Promise.all([slow, fast]);
  const list = (await call('GET', '/restaurants')).body.restaurants.map((r) => r.id);
  assert.deepEqual(list, ['r_fast']);
});

test('screens are HTML; assets are served locally', async () => {
  for (const path of ['/', '/signup', '/login', '/lookup']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"]*/g, '')), `external URL in ${path}`);
  }
  for (const asset of ['/assets/app.js', '/assets/app.css']) {
    assert.equal((await fetch(base + asset)).status, 200);
  }
  assert.equal((await fetch(`${base}/assets/nope.js`)).status, 404);
});
