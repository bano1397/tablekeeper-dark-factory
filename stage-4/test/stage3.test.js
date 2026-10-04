'use strict';
// Stage 3 API: explanations, history, policies and accepted terms, revisions, series.
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
const newKey = () => `s3-${process.pid}-${++keySeq}`;

async function call(method, path, { body, token, key } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key !== undefined) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function expectError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code, JSON.stringify(res.body));
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const allWeek = (opens = '18:00', closes = '23:00') => WEEKDAYS.map((weekday) => ({ weekday, opens, closes }));
const restaurant = (over = {}) => ({
  id: 'r_anker', name: 'Zum Anker', timezone: 'Europe/Berlin', slot_minutes: 30,
  reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120, opening_hours: allWeek(),
  tables: [{ id: 't_1', label: '1', capacity: 2 }, { id: 't_2', label: '2', capacity: 4 }, { id: 't_3', label: '3', capacity: 6 }],
  combinable: [['t_1', 't_2']],
  manager_user_ids: ['u_ada'],
  ...over,
});
const ADA = { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' };
const BOB = { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob' };
const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const date = dayPlus(7);

async function world(fixture = {}) {
  const res = await call('POST', '/_test/reset', { body: { users: [ADA, BOB], restaurants: [restaurant()], ...fixture } });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const login = async (u) => (await call('POST', '/auth/login', { body: { email: u.email, password: u.password } })).body.token;
  return { ada: await login(ADA), bob: await login(BOB) };
}

const book = (token, over = {}, key = newKey()) => call('POST', '/reservations', {
  token, key, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${date}T19:00`, party_size: 2, ...over },
});
const policy = (effective, over = {}) => ({
  effective_from: effective, slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
  opening_hours: allWeek(), capacities: { t_1: 2, t_2: 4, t_3: 6 }, ...over,
});
const publish = (token, body, key = newKey()) => call('POST', '/restaurants/r_anker/policies', { token, key, body });
const patch = (token, ref, body) => call('PATCH', `/reservations/${ref}`, { token, body });
const history = async (token, ref) => (await call('GET', `/reservations/${ref}/history`, { token })).body.entries;

// ---- explanations ------------------------------------------------------------------

test('explain: only "true" is accepted; without it the shape is unchanged', async () => {
  await world();
  for (const bad of ['false', '1', '', 'TRUE']) {
    expectError(await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=2&explain=${bad}`), 422, 'validation_failed');
  }
  const plain = await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=2`);
  assert.ok(plain.body.slots.every((s) => !('explain' in s)));
});

test('explain reports both rules for every table, including ones excluded by both', async () => {
  const { ada } = await world();
  await book(ada, { table_id: 't_1', party_size: 1 });
  const slot = (await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=3&explain=true`))
    .body.slots.find((s) => s.starts_at_local.endsWith('19:00'));
  assert.deepEqual(slot.explain, [
    { table_id: 't_1', policy_version: 0, available: false, rules: [{ rule: 'capacity', holds: false }, { rule: 'no_overlap', holds: false }] },
    { table_id: 't_2', policy_version: 0, available: true, rules: [{ rule: 'capacity', holds: true }, { rule: 'no_overlap', holds: true }] },
    { table_id: 't_3', policy_version: 0, available: true, rules: [{ rule: 'capacity', holds: true }, { rule: 'no_overlap', holds: true }] },
  ]);
  assert.deepEqual(slot.available_table_ids, ['t_2', 't_3']);
});

test('explain names the selected policy version and uses its capacities', async () => {
  const { ada } = await world();
  await publish(ada, policy(date, { capacities: { t_1: 8, t_2: 4, t_3: 6 } }));
  const slot = (await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=8&explain=true`)).body.slots[0];
  assert.deepEqual(slot.explain.map((e) => [e.table_id, e.policy_version, e.available]), [['t_1', 1, true], ['t_2', 1, false], ['t_3', 1, false]]);
  const before = (await call('GET', `/availability?restaurant_id=r_anker&date=${dayPlus(6)}&party_size=8&explain=true`)).body.slots[0];
  assert.ok(before.explain.every((e) => e.policy_version === 0 && !e.available));
});

// ---- history ---------------------------------------------------------------------------

test('history: created, only-changed fields in order, no-op records nothing, cancelled last', async () => {
  const { ada } = await world();
  const r = (await book(ada)).body;
  assert.equal(r.revision, 1);
  const noop = await patch(ada, r.reference, { party_size: 2, table_id: 't_2', starts_at_local: `${date}T19:00` });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.revision, 1);
  const changed = await patch(ada, r.reference, { party_size: 3, starts_at_local: `${date}T20:00`, table_id: 't_3' });
  assert.equal(changed.body.revision, 2);
  assert.equal((await call('POST', `/reservations/${r.reference}/cancel`, { token: ada })).body.revision, 3);
  assert.equal((await call('POST', `/reservations/${r.reference}/cancel`, { token: ada })).body.revision, 3);
  const entries = await history(ada, r.reference);
  assert.deepEqual(entries.map((e) => [e.seq, e.event, e.revision]), [[1, 'created', 1], [2, 'changed', 2], [3, 'cancelled', 3]]);
  assert.deepEqual(entries[0].changes, [
    { field: 'table_id', from: null, to: 't_2' },
    { field: 'starts_at_local', from: null, to: `${date}T19:00` },
    { field: 'party_size', from: null, to: 2 }]);
  assert.deepEqual(entries[1].changes, [
    { field: 'table_id', from: 't_2', to: 't_3' },
    { field: 'starts_at_local', from: `${date}T19:00`, to: `${date}T20:00` },
    { field: 'party_size', from: 2, to: 3 }]);
  assert.deepEqual(entries[2].changes, []);
  for (const e of entries) {
    assert.match(e.at, /[+-]\d{2}:\d{2}$/);
    assert.equal(e.accepted_terms.policy_version, 0);
  }
});

test('history and decision are owner-only 404s, even without a token', async () => {
  const { ada, bob } = await world();
  const r = (await book(ada)).body;
  for (const suffix of ['history', 'decision']) {
    expectError(await call('GET', `/reservations/${r.reference}/${suffix}`), 404, 'not_found');
    expectError(await call('GET', `/reservations/${r.reference}/${suffix}`, { token: bob }), 404, 'not_found');
    expectError(await call('GET', `/reservations/${r.reference}/${suffix}`, { token: 'garbage' }), 404, 'not_found');
    expectError(await call('GET', `/reservations/NOPE99/${suffix}`, { token: ada }), 404, 'not_found');
  }
  await call('POST', `/reservations/${r.reference}/cancel`, { token: ada });
  const decision = await call('GET', `/reservations/${r.reference}/decision`, { token: ada });
  assert.deepEqual(decision.body, { reference: r.reference, revision: 2, accepted_terms: r.accepted_terms });
});

test('a replayed create records no history', async () => {
  const { ada } = await world();
  const key = newKey();
  const r = (await book(ada, {}, key)).body;
  assert.equal((await book(ada, {}, key)).status, 200);
  assert.equal((await history(ada, r.reference)).length, 1);
});

test('combined-table history uses table_ids; a reversed pair is not an amendment', async () => {
  const { ada } = await world();
  const r = (await book(ada, { table_id: undefined, table_ids: ['t_2', 't_1'], party_size: 5 })).body;
  const same = await patch(ada, r.reference, { table_ids: ['t_2', 't_1'] });
  assert.equal(same.body.revision, 1);
  await patch(ada, r.reference, { table_id: 't_3' });
  await patch(ada, r.reference, { table_id: 't_2', party_size: 4 });
  const entries = await history(ada, r.reference);
  assert.deepEqual(entries[0].changes[0], { field: 'table_ids', from: null, to: ['t_1', 't_2'] });
  assert.deepEqual(entries[1].changes, [{ field: 'table_ids', from: ['t_1', 't_2'], to: ['t_3'] }]);
  assert.deepEqual(entries[2].changes, [{ field: 'table_id', from: 't_3', to: 't_2' }, { field: 'party_size', from: 5, to: 4 }]);
  assert.equal(entries.length, 3);
});

test('seeded bookings start at revision 1 under policy 0 with a created entry', async () => {
  const seed = { id: 'res_s', reference: 'SEED01', user_id: 'u_ada', restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${date}T19:00`, party_size: 2 };
  const { ada } = await world({ reservations: [seed] });
  const got = (await call('GET', '/reservations/SEED01', { token: ada })).body;
  assert.equal(got.revision, 1);
  assert.equal(got.accepted_terms.policy_version, 0);
  assert.equal((await history(ada, 'SEED01'))[0].event, 'created');
});

// ---- policies ------------------------------------------------------------------------

test('policy publication: permissions, idempotency and versions', async () => {
  const { ada, bob } = await world();
  expectError(await call('POST', '/restaurants/r_anker/policies', { key: newKey(), body: policy(date) }), 401, 'unauthenticated');
  expectError(await publish(bob, policy(date)), 403, 'forbidden');
  expectError(await call('POST', '/restaurants/r_nope/policies', { token: ada, key: newKey(), body: policy(date) }), 404, 'not_found');
  expectError(await call('POST', '/restaurants/r_anker/policies', { token: ada, body: policy(date) }), 400, 'missing_idempotency_key');
  const key = newKey();
  const first = await publish(ada, policy(date), key);
  assert.equal(first.status, 201);
  assert.equal(first.body.policy_version, 1);
  assert.equal(first.body.effective_from, date);
  const replay = await publish(ada, policy(date), key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  expectError(await publish(ada, policy(dayPlus(1)), key), 409, 'idempotency_key_reuse');
  expectError(await publish(ada, policy('2026-02-30')), 422, 'validation_failed');
  assert.equal((await publish(ada, policy(dayPlus(1)))).body.policy_version, 2);
  const listed = (await call('GET', '/restaurants/r_anker/policies')).body.policies;
  assert.deepEqual(listed.map((p) => p.policy_version), [1, 2]);
  expectError(await call('GET', '/restaurants/r_nope/policies'), 404, 'not_found');
});

test('invalid policies are 422 and allocate no version', async () => {
  const { ada } = await world();
  const bad = [
    policy(date, { slot_minutes: 0 }), policy(date, { slot_minutes: 1441 }), policy(date, { slot_minutes: true }),
    policy(date, { reservation_duration_minutes: 1.5 }), policy(date, { cancellation_cutoff_minutes: 10081 }),
    policy(date, { cancellation_cutoff_minutes: -1 }), policy(date, { capacities: { t_1: 2, t_2: 4 } }),
    policy(date, { capacities: { t_1: 2, t_2: 4, t_3: 6, t_9: 1 } }), policy(date, { capacities: { t_1: 0, t_2: 4, t_3: 6 } }),
    policy(date, { capacities: { t_1: 101, t_2: 4, t_3: 6 } }), policy(date, { capacities: { t_1: false, t_2: 4, t_3: 6 } }),
    policy(date, { opening_hours: [{ weekday: 'mon', opens: '18:00', closes: '23:00' }, { weekday: 'mon', opens: '10:00', closes: '12:00' }] }),
    policy(date, { opening_hours: [{ weekday: 'mon', opens: '23:00', closes: '18:00' }] }),
    policy('tomorrow'), (() => { const p = policy(date); delete p.capacities; return p; })(),
  ];
  for (const body of bad) expectError(await publish(ada, body), 422, 'validation_failed');
  assert.equal((await publish(ada, policy(date, { extra: 'ignored' }))).body.policy_version, 1);
});

test('selection by local start date: greatest effective_from, ties by version; not retroactive', async () => {
  const { ada } = await world();
  const before = (await book(ada, { table_id: 't_3' })).body;
  await publish(ada, policy(dayPlus(-30), { reservation_duration_minutes: 60 })); // v1, past
  await publish(ada, policy(date, { reservation_duration_minutes: 120 })); // v2
  await publish(ada, policy(date, { reservation_duration_minutes: 30 })); // v3, same date supersedes
  await publish(ada, policy(dayPlus(30), { reservation_duration_minutes: 45 })); // v4, later date
  const unchanged = (await call('GET', `/reservations/${before.reference}`, { token: ada })).body;
  assert.deepEqual(unchanged, before);
  assert.equal((await history(ada, before.reference)).length, 1);
  const onDate = (await book(ada, { table_id: 't_1' })).body;
  assert.equal(onDate.accepted_terms.policy_version, 3);
  assert.equal(onDate.ends_at.slice(11, 16), '19:30');
  const earlier = (await book(ada, { starts_at_local: `${dayPlus(6)}T19:00` })).body;
  assert.equal(earlier.accepted_terms.policy_version, 1);
  const later = (await book(ada, { starts_at_local: `${dayPlus(31)}T19:00` })).body;
  assert.equal(later.accepted_terms.policy_version, 4);
  const detail = (await call('GET', '/restaurants/r_anker')).body;
  assert.equal(detail.reservation_duration_minutes, 90);
});

test('policy opening hours, grid and capacity drive bookings', async () => {
  const { ada } = await world();
  await publish(ada, policy(date, { slot_minutes: 60, opening_hours: allWeek('12:00', '16:00'), capacities: { t_1: 2, t_2: 3, t_3: 6 } }));
  expectError(await book(ada), 422, 'outside_opening_hours');
  expectError(await book(ada, { starts_at_local: `${date}T12:30` }), 422, 'not_on_slot_grid');
  expectError(await book(ada, { starts_at_local: `${date}T13:00`, party_size: 4 }), 422, 'party_exceeds_capacity');
  assert.equal((await book(ada, { table_id: 't_3', starts_at_local: `${date}T13:00`, party_size: 3 })).status, 201);
  const pair = await book(ada, { table_id: undefined, table_ids: ['t_1', 't_2'], starts_at_local: `${date}T14:00`, party_size: 5 });
  assert.equal(pair.status, 201);
  expectError(await book(ada, { table_id: undefined, table_ids: ['t_1', 't_2'], starts_at_local: `${date}T13:00`, party_size: 6 }), 422, 'party_exceeds_capacity');
});

test('amendment checks old cutoff, then adopts the resulting date policy; cancel uses accepted cutoff', async () => {
  const { ada } = await world();
  const r = (await book(ada)).body;
  // Cutoff 10080 min (7 days, the maximum): a booking 5 days out is inside it.
  assert.equal((await publish(ada, policy(dayPlus(5), { reservation_duration_minutes: 60, cancellation_cutoff_minutes: 10080 }))).status, 201);
  const moved = (await patch(ada, r.reference, { starts_at_local: `${dayPlus(5)}T19:00` })).body;
  assert.equal(moved.revision, 2);
  assert.equal(moved.accepted_terms.policy_version, 1);
  assert.equal(moved.ends_at.slice(11, 16), '20:00');
  expectError(await call('POST', `/reservations/${r.reference}/cancel`, { token: ada }), 409, 'cutoff_passed');
  expectError(await patch(ada, r.reference, { party_size: 1 }), 409, 'cutoff_passed');
  const entries = await history(ada, r.reference);
  assert.equal(entries[0].accepted_terms.policy_version, 0); // old entries keep old terms
  assert.equal(entries[1].accepted_terms.policy_version, 1);
});

test('a real amendment re-validates all fields under the resulting policy', async () => {
  const { ada } = await world();
  const r = (await book(ada, { party_size: 4 })).body;
  await publish(ada, policy(dayPlus(-1), { capacities: { t_1: 2, t_2: 3, t_3: 6 } }));
  expectError(await patch(ada, r.reference, { starts_at_local: `${date}T19:30` }), 422, 'party_exceeds_capacity');
  const still = (await call('GET', `/reservations/${r.reference}`, { token: ada })).body;
  assert.deepEqual(still, r);
  assert.equal((await patch(ada, r.reference, { party_size: 4 })).body.revision, 1); // no-op keeps terms
});

// ---- revisions -----------------------------------------------------------------------

test('expected_revision: stale before cutoff, invalid is 422', async () => {
  const { ada } = await world();
  const r = (await book(ada)).body;
  for (const bad of [0, -1, 1.5, '1', true, null]) {
    expectError(await patch(ada, r.reference, { party_size: 3, expected_revision: bad }), 422, 'validation_failed');
  }
  expectError(await patch(ada, r.reference, { party_size: 3, expected_revision: 2 }), 409, 'stale_revision');
  assert.equal((await patch(ada, r.reference, { party_size: 3, expected_revision: 1 })).body.revision, 2);
  const past = (await book(ada, { starts_at_local: '2020-01-02T19:00' })).body;
  expectError(await patch(ada, past.reference, { party_size: 1, expected_revision: 9 }), 409, 'stale_revision');
});

test('concurrent amendments from one revision: at most one real change', async () => {
  const { ada } = await world();
  const r = (await book(ada)).body;
  const out = await Promise.all([1, 3, 4].map((p) => patch(ada, r.reference, { party_size: p, expected_revision: 1 })));
  assert.equal(out.filter((x) => x.status === 200).length, 1);
  assert.equal(out.filter((x) => x.status === 409 && x.body.error.code === 'stale_revision').length, 2);
  assert.equal((await history(ada, r.reference)).length, 2);
});

// ---- series ----------------------------------------------------------------------------

test('series adoption: anchor unchanged, occurrences weekly, ordinary bookings', async () => {
  const { ada } = await world();
  const anchor = (await book(ada)).body;
  const key = newKey();
  const res = await call('POST', '/series', { token: ada, key, body: { anchor_reference: anchor.reference, count: 4, interval_weeks: 2, extra: 1 } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const s = res.body;
  assert.equal(s.revision, 1);
  assert.equal(s.interval_weeks, 2);
  assert.deepEqual(s.occurrences.map((o) => o.index), [0, 1, 2, 3]);
  assert.deepEqual(s.occurrences[0].reservation, anchor);
  assert.deepEqual(s.occurrences.map((o) => o.reservation.starts_at_local),
    [0, 14, 28, 42].map((d) => `${dayPlus(7 + d)}T19:00`));
  assert.equal(new Set(s.occurrences.map((o) => o.reference)).size, 4);
  assert.ok(s.occurrences.every((o) => o.exception === false && o.reservation.revision === 1));
  assert.equal((await call('GET', '/reservations', { token: ada })).body.reservations.length, 4);
  assert.equal((await history(ada, s.occurrences[2].reference))[0].event, 'created');
  const replay = await call('POST', '/series', { token: ada, key, body: { anchor_reference: anchor.reference, count: 4, interval_weeks: 2, extra: 1 } });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, s);
  expectError(await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } }), 409, 'already_in_series');
  expectError(await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: s.occurrences[1].reference, count: 2, interval_weeks: 1 } }), 409, 'already_in_series');
});

test('series validation errors', async () => {
  const { ada, bob } = await world();
  const anchor = (await book(ada)).body;
  const post = (body, token = ada) => call('POST', '/series', { token, key: newKey(), body });
  for (const [count, weeks] of [[1, 1], [13, 1], [true, 1], [2.5, 1], [2, 0], [2, 5], [2, true], ['2', 1]]) {
    expectError(await post({ anchor_reference: anchor.reference, count, interval_weeks: weeks }), 422, 'validation_failed');
  }
  expectError(await post({ count: 2, interval_weeks: 1 }), 422, 'validation_failed');
  expectError(await post({ anchor_reference: anchor.reference, count: 2, interval_weeks: 1 }, bob), 404, 'not_found');
  expectError(await post({ anchor_reference: 'NOPE99', count: 2, interval_weeks: 1 }), 404, 'not_found');
  expectError(await call('POST', '/series', { key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } }), 401, 'unauthenticated');
  expectError(await call('POST', '/series', { token: ada, body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } }), 400, 'missing_idempotency_key');
  await call('POST', `/reservations/${anchor.reference}/cancel`, { token: ada });
  expectError(await post({ anchor_reference: anchor.reference, count: 2, interval_weeks: 1 }), 409, 'reservation_cancelled');
  const past = (await book(ada, { starts_at_local: '2020-01-02T19:00' })).body;
  expectError(await post({ anchor_reference: past.reference, count: 2, interval_weeks: 1 }), 409, 'cutoff_passed');
});

test('a failing occurrence rejects the whole adoption and leaves nothing behind', async () => {
  const { ada, bob } = await world();
  const anchor = (await book(ada)).body;
  await book(bob, { starts_at_local: `${dayPlus(21)}T19:30` }); // blocks occurrence 2
  const key = newKey();
  const body = { anchor_reference: anchor.reference, count: 4, interval_weeks: 1 };
  expectError(await call('POST', '/series', { token: ada, key, body }), 409, 'table_unavailable');
  assert.equal((await call('GET', '/reservations', { token: ada })).body.reservations.length, 1);
  const free = (await call('GET', `/availability?restaurant_id=r_anker&date=${dayPlus(14)}&party_size=2`)).body
    .slots.find((sl) => sl.starts_at_local.endsWith('19:00'));
  assert.ok(free.available_table_ids.includes('t_2'));
  // Earlier occurrence fails first in index order.
  await publish(ada, policy(dayPlus(14), { opening_hours: allWeek('12:00', '16:00') }));
  expectError(await call('POST', '/series', { token: ada, key: newKey(), body }), 422, 'outside_opening_hours');
  // The failed key was not claimed: a different body under it is a first use, not a reuse.
  const again = await call('POST', '/series', { token: ada, key, body: { ...body, count: 2 } });
  expectError(again, 422, 'outside_opening_hours');
});

test('each occurrence selects its own date policy; DST gaps reject the adoption', async () => {
  const { ada } = await world({ restaurants: [restaurant({ opening_hours: allWeek('00:00', '23:30') })] });
  await publish(ada, policy(dayPlus(14), { reservation_duration_minutes: 60, opening_hours: allWeek('00:00', '23:30') }));
  const anchor = (await book(ada)).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 3, interval_weeks: 1 } })).body;
  // Occurrence 1 falls on the policy's effective date itself, so it already uses it.
  assert.deepEqual(s.occurrences.map((o) => o.reservation.accepted_terms.policy_version), [0, 1, 1]);
  assert.equal(s.occurrences[2].reservation.ends_at.slice(11, 16), '20:00');
  // 2027-03-28 is Berlin's spring-forward date; an anchor one week earlier at 02:30 hits the gap.
  const dst = (await book(ada, { starts_at_local: '2027-03-21T02:30' })).body;
  expectError(await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: dst.reference, count: 2, interval_weeks: 1 } }), 422, 'invalid_local_time');
});

test('series revision and exceptions; owner-only read', async () => {
  const { ada, bob } = await world();
  const anchor = (await book(ada)).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 3, interval_weeks: 1 } })).body;
  const [o0, o1, o2] = s.occurrences.map((o) => o.reference);
  await patch(ada, o1, { party_size: 2 }); // no-op
  let cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.equal(cur.revision, 1);
  await patch(ada, o1, { party_size: 3 });
  cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.equal(cur.revision, 2);
  assert.deepEqual(cur.occurrences.map((o) => o.exception), [false, true, false]);
  await call('POST', `/reservations/${o0}/cancel`, { token: ada });
  await call('POST', `/reservations/${o0}/cancel`, { token: ada });
  cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.equal(cur.revision, 3);
  assert.deepEqual(cur.occurrences.map((o) => [o.exception, o.reservation.status]),
    [[false, 'cancelled'], [true, 'confirmed'], [false, 'confirmed']]);
  assert.equal(cur.occurrences[2].reference, o2);
  expectError(await call('GET', `/series/${s.series_id}`, { token: bob }), 404, 'not_found');
  expectError(await call('GET', `/series/${s.series_id}`), 404, 'not_found');
});

test('moves under policies: revisions, history, series exceptions; failure changes nothing', async () => {
  const { ada } = await world();
  const anchor = (await book(ada, { table_id: 't_1' })).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  const other = (await book(ada, { table_id: 't_3' })).body;
  const mv = (moves) => call('POST', '/reservation-moves', { token: ada, key: newKey(), body: { moves } });
  expectError(await mv([{ reference: anchor.reference, table_id: 't_2' }, { reference: other.reference, party_size: 3, expected_revision: 5 }]), 409, 'stale_revision');
  assert.equal((await history(ada, anchor.reference)).length, 1);
  const ok = await mv([{ reference: anchor.reference, table_id: 't_2', expected_revision: 1 }, { reference: other.reference, party_size: 2 }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.reservations.map((r) => r.revision), [2, 1]);
  assert.equal((await history(ada, other.reference)).length, 1);
  const cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.equal(cur.revision, 2);
  assert.deepEqual(cur.occurrences.map((o) => o.exception), [true, false]);
});

test('stage-2 exports import; adoption works on imported reservations', async () => {
  const { ada } = await world();
  const exported = (await call('GET', '/_test/export')).body;
  const userId = exported.state.users.find((u) => u.email === ADA.email).id;
  const startMs = Date.parse(`${date}T19:00:00+02:00`);
  const receipt = {
    reservation_id: 'res_old', reference: 'OLD123', restaurant_id: 'r_anker', table_id: 't_2', table_ids: ['t_2'],
    party_size: 2, status: 'confirmed', starts_at_local: `${date}T19:00`, starts_at: `${date}T19:00:00+02:00`,
    ends_at: `${date}T20:30:00+02:00`, created_at: '2026-01-01T10:00:00+00:00',
  };
  const { manager_user_ids: _m, ...stage2Restaurant } = restaurant();
  const stage2 = {
    track: 'tablekeeper', format_version: 1,
    state: {
      users: exported.state.users, tokens: exported.state.tokens, restaurants: [stage2Restaurant],
      reservations: [{ ...receipt, table_id: undefined, user_id: userId, start_ms: startMs, end_ms: startMs + 90 * 60000 }],
      idempotency: [],
    },
  };
  delete stage2.state.reservations[0].table_id;
  assert.equal((await call('POST', '/_test/import', { body: stage2 })).status, 204);
  const got = (await call('GET', '/reservations/OLD123', { token: ada })).body;
  assert.equal(got.revision, 1);
  assert.equal(got.accepted_terms.policy_version, 0);
  assert.equal((await history(ada, 'OLD123'))[0].event, 'created');
  const s = await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: 'OLD123', count: 2, interval_weeks: 1 } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  // Round trip of a stage-3 export keeps series, policies and history.
  const snap = (await call('GET', '/_test/export')).body;
  await world();
  assert.equal((await call('POST', '/_test/import', { body: snap })).status, 204);
  assert.equal((await call('GET', `/series/${s.body.series_id}`, { token: ada })).status, 200);
});

// ---- auditor stage-3 gap list -------------------------------------------------------------

test('explain on a fully unavailable slot and a closed day (items 4-5)', async () => {
  const { ada, bob } = await world();
  await book(ada, { table_id: 't_2', party_size: 2 });
  await book(bob, { table_id: 't_3', party_size: 2 });
  await book(ada, { table_id: 't_1', party_size: 2 });
  const slot = (await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=2&explain=true`))
    .body.slots.find((s) => s.starts_at_local.endsWith('19:00'));
  assert.deepEqual(slot.available_table_ids, []);
  assert.deepEqual(slot.explain.map((e) => [e.table_id, e.available, e.rules[0].holds, e.rules[1].holds, e.policy_version]),
    [['t_1', false, true, false, 0], ['t_2', false, true, false, 0], ['t_3', false, true, false, 0]]);
  const closed = WEEKDAYS.filter((d) => d !== WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7])
    .map((weekday) => ({ weekday, opens: '18:00', closes: '23:00' }));
  await world({ restaurants: [restaurant({ opening_hours: closed })] });
  assert.deepEqual((await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=2&explain=true`)).body.slots, []);
});

test('seq stays total under concurrent writes in the same second (item 11)', async () => {
  const { ada } = await world();
  const r = (await book(ada)).body;
  await Promise.all([3, 4, 1, 2, 3].map((p) => patch(ada, r.reference, { party_size: p })));
  const entries = await history(ada, r.reference);
  assert.deepEqual(entries.map((e) => e.seq), entries.map((_, i) => i + 1));
  assert.deepEqual(entries.map((e) => e.revision), entries.map((_, i) => i + 1));
});

test('managers do not gain access to other diners\' bookings (item 15)', async () => {
  const { ada, bob } = await world(); // ada is the manager
  const r = (await book(bob)).body;
  for (const path of [`/reservations/${r.reference}`, `/reservations/${r.reference}/history`, `/reservations/${r.reference}/decision`]) {
    expectError(await call('GET', path, { token: ada }), 404, 'not_found');
  }
  expectError(await call('POST', `/reservations/${r.reference}/cancel`, { token: ada }), 404, 'not_found');
  expectError(await patch(ada, r.reference, { party_size: 1 }), 404, 'not_found');
});

test('a policy cannot change tables, labels, timezone or combinations (item 18)', async () => {
  const { ada } = await world();
  const res = await publish(ada, policy(date, {
    tables: [{ id: 't_9', label: 'X', capacity: 9 }], timezone: 'America/New_York', combinable: [['t_1', 't_3']],
  }));
  assert.equal(res.status, 201);
  assert.ok(!('tables' in res.body) && !('timezone' in res.body) && !('combinable' in res.body));
  const detail = (await call('GET', '/restaurants/r_anker')).body;
  assert.deepEqual(detail.tables.map((t) => t.id), ['t_1', 't_2', 't_3']);
  assert.equal(detail.timezone, 'Europe/Berlin');
  expectError(await book(ada, { table_id: undefined, table_ids: ['t_1', 't_3'], party_size: 5 }), 422, 'combination_not_allowed');
});

test('old idempotency keys replay the original revision and terms after a new policy (item 28)', async () => {
  const { ada } = await world();
  const key = newKey();
  const first = (await book(ada, {}, key)).body;
  await publish(ada, policy(dayPlus(-1), { reservation_duration_minutes: 60 }));
  await patch(ada, first.reference, { party_size: 3 });
  const replay = await book(ada, {}, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first);
  assert.equal(replay.body.accepted_terms.policy_version, 0);
});

test('adoption leaves the anchor history, timestamps and original receipt untouched (item 40)', async () => {
  const { ada } = await world();
  const key = newKey();
  const anchor = (await book(ada, {}, key)).body;
  const before = await history(ada, anchor.reference);
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  assert.deepEqual(await history(ada, anchor.reference), before);
  assert.deepEqual((await book(ada, {}, key)).body, anchor);
  assert.deepEqual((await call('GET', `/reservations/${anchor.reference}`, { token: ada })).body, anchor);
  assert.equal(s.occurrences[0].reference, anchor.reference);
});

test('a repeated local time in an occurrence uses the first occurrence (item 44)', async () => {
  const { ada } = await world({ restaurants: [restaurant({ opening_hours: allWeek('00:00', '23:30') })] });
  // 2027-10-31 is Berlin's fall-back date; 02:30 occurs twice and resolves to CEST (+02:00).
  const anchor = (await book(ada, { starts_at_local: '2027-10-24T02:30' })).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  assert.equal(s.occurrences[1].reservation.starts_at, '2027-10-31T02:30:00+02:00');
});

test('series references and indices survive amendments; GET shows current state (items 47, 49)', async () => {
  const { ada } = await world();
  const anchor = (await book(ada)).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  const ref = s.occurrences[1].reference;
  await patch(ada, ref, { starts_at_local: `${dayPlus(15)}T20:00`, table_id: 't_3' });
  const cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.deepEqual(cur.occurrences.map((o) => [o.index, o.reference]), [[0, anchor.reference], [1, ref]]);
  assert.equal(cur.occurrences[1].reservation.starts_at_local, `${dayPlus(15)}T20:00`);
  assert.equal(cur.occurrences[1].reservation.table_id, 't_3');
  assert.equal(cur.occurrences[1].exception, true);
});

test('series on a combined-table anchor uses each date policy capacity for the pair (item 61)', async () => {
  const { ada } = await world();
  const anchor = (await book(ada, { table_id: undefined, table_ids: ['t_1', 't_2'], party_size: 6 })).body;
  await publish(ada, policy(dayPlus(14), { capacities: { t_1: 2, t_2: 3, t_3: 6 } }));
  expectError(await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } }), 422, 'party_exceeds_capacity');
  await publish(ada, policy(dayPlus(14), { capacities: { t_1: 3, t_2: 3, t_3: 6 } }));
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  assert.deepEqual(s.occurrences[1].reservation.table_ids, ['t_1', 't_2']);
  assert.equal(s.occurrences[1].reservation.accepted_terms.policy_version, 2);
  assert.deepEqual((await history(ada, s.occurrences[1].reference))[0].changes[0], { field: 'table_ids', from: null, to: ['t_1', 't_2'] });
});

test('moves: old cutoff first, resulting-date policy adopted; replay changes nothing (items 62, 67)', async () => {
  const { ada } = await world();
  const past = (await book(ada, { starts_at_local: '2020-01-02T19:00' })).body;
  const r = (await book(ada)).body;
  const mv = (moves, key = newKey()) => call('POST', '/reservation-moves', { token: ada, key, body: { moves } });
  expectError(await mv([{ reference: r.reference, party_size: 3 }, { reference: past.reference, party_size: 1 }]), 409, 'cutoff_passed');
  assert.equal((await history(ada, r.reference)).length, 1);
  await publish(ada, policy(dayPlus(9), { reservation_duration_minutes: 45 }));
  const key = newKey();
  const moves = [{ reference: r.reference, starts_at_local: `${dayPlus(9)}T19:00` }];
  const ok = await mv(moves, key);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.reservations[0].accepted_terms.policy_version, 1);
  assert.equal(ok.body.reservations[0].ends_at.slice(11, 16), '19:45');
  const replay = await mv(moves, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, ok.body);
  assert.equal((await history(ada, r.reference)).length, 2);
  assert.equal((await call('GET', `/reservations/${r.reference}`, { token: ada })).body.revision, 2);
});
