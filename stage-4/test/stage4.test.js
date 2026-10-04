'use strict';
// Stage 4 API: seating changes after a closure, and amending recurring reservations.
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
const newKey = () => `s4-${process.pid}-${++keySeq}`;

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
  tables: [{ id: 't_1', label: '1', capacity: 2 }, { id: 't_2', label: '2', capacity: 4 },
    { id: 't_3', label: '3', capacity: 6 }, { id: 't_4', label: '4', capacity: 6 }],
  combinable: [['t_1', 't_2'], ['t_2', 't_3']],
  manager_user_ids: ['u_ada'],
  ...over,
});
const ADA = { id: 'u_ada', email: 'ada@example.com', password: 'correct horse', display_name: 'Ada' };
const BOB = { id: 'u_bob', email: 'bob@example.com', password: 'correct horse', display_name: 'Bob' };
const dayPlus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const date = dayPlus(7);
// Berlin offset on `date`: CEST until the last Sunday of October, CET after.
const offsetFor = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' })
  .formatToParts(new Date(`${d}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
const instant = (d, hhmm) => `${d}T${hhmm}:00${offsetFor(d)}`;

async function world(fixture = {}) {
  const res = await call('POST', '/_test/reset', { body: { users: [ADA, BOB], restaurants: [restaurant()], ...fixture } });
  assert.equal(res.status, 204, JSON.stringify(res.body));
  const login = async (u) => (await call('POST', '/auth/login', { body: { email: u.email, password: u.password } })).body.token;
  return { ada: await login(ADA), bob: await login(BOB) };
}

const book = (token, over = {}, key = newKey()) => call('POST', '/reservations', {
  token, key, body: { restaurant_id: 'r_anker', table_id: 't_2', starts_at_local: `${date}T19:00`, party_size: 2, ...over },
});
const preview = (token, body, rid = 'r_anker', key = newKey()) => call('POST', `/restaurants/${rid}/replans`, { token, key, body });
const close = (table, d = date, from = '18:00', to = '23:00') => ({ table_id: table, from: instant(d, from), to: instant(d, to) });
const apply = (token, planId, key = newKey(), rid = 'r_anker') => call('POST', `/restaurants/${rid}/replans/${planId}/apply`, { token, key, body: {} });
const revisionNow = async (token) => (await preview(token, close('t_1', dayPlus(300)))).body.restaurant_revision;
const history = async (token, ref) => (await call('GET', `/reservations/${ref}/history`, { token })).body.entries;

// ---- replans: validation ---------------------------------------------------------------

test('replan preview: permissions, key, interval and table validation', async () => {
  const { ada, bob } = await world();
  expectError(await call('POST', '/restaurants/r_anker/replans', { key: newKey(), body: close('t_2') }), 401, 'unauthenticated');
  expectError(await preview(bob, close('t_2')), 403, 'forbidden');
  expectError(await preview(ada, close('t_2'), 'r_nope'), 404, 'not_found');
  expectError(await call('POST', '/restaurants/r_anker/replans', { token: ada, body: close('t_2') }), 400, 'missing_idempotency_key');
  expectError(await preview(ada, close('t_9')), 404, 'not_found');
  expectError(await preview(ada, { ...close('t_2'), from: `${date}T18:00:00` }), 422, 'validation_failed');
  expectError(await preview(ada, close('t_2', date, '20:00', '20:00')), 422, 'validation_failed');
  expectError(await preview(ada, close('t_2', date, '21:00', '20:00')), 422, 'validation_failed');
  expectError(await preview(ada, { table_id: 't_2', from: instant(date, '18:00') }), 422, 'validation_failed');
  expectError(await preview(ada, { ...close('t_2'), from: '2026-02-30T18:00:00+01:00' }), 422, 'validation_failed');
});

// ---- replans: optimality -----------------------------------------------------------------

test('minimises moved bookings, then unused seats, then option rank', async () => {
  const { ada, bob } = await world();
  const a = (await book(ada, { table_id: 't_2', party_size: 2 })).body; // on the closed table
  const b = (await book(bob, { table_id: 't_1', party_size: 2 })).body; // fits a perfectly, but moving it costs a move
  const res = await preview(ada, close('t_2'));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const byRef = Object.fromEntries(res.body.assignments.map((x) => [x.reference, x]));
  // Moving only `a` (to t_3 or t_4, 4 unused seats) beats moving two bookings; t_3 outranks t_4.
  assert.deepEqual(byRef[a.reference], { reference: a.reference, table_ids: ['t_3'], changed: true });
  assert.deepEqual(byRef[b.reference], { reference: b.reference, table_ids: ['t_1'], changed: false });
  assert.equal(res.body.moved_count, 1);
  assert.equal(res.body.unused_seats, 4);
  assert.deepEqual(res.body.assignments.map((x) => x.reference), [a.reference, b.reference].sort());
  assert.deepEqual(res.body.closure, close('t_2'));
});

test('prefers fewer unused seats among single moves', async () => {
  const { ada } = await world({ restaurants: [restaurant({ tables: [
    { id: 't_1', label: '1', capacity: 6 }, { id: 't_2', label: '2', capacity: 4 }, { id: 't_3', label: '3', capacity: 4 }] })] });
  const a = (await book(ada, { table_id: 't_2', party_size: 4 })).body;
  const res = (await preview(ada, close('t_2'))).body;
  assert.deepEqual(res.assignments, [{ reference: a.reference, table_ids: ['t_3'], changed: true }]);
  assert.equal(res.unused_seats, 0);
});

test('capacity follows each booking\'s own accepted terms', async () => {
  const { ada } = await world();
  // Booked under policy 0 (t_1 seats 2), later a policy makes t_1 seat 4.
  const a = (await book(ada, { table_id: 't_2', party_size: 3 })).body;
  await call('POST', '/restaurants/r_anker/policies', { token: ada, key: newKey(), body: {
    effective_from: dayPlus(-1), slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
    opening_hours: allWeek(), capacities: { t_1: 4, t_2: 4, t_3: 6, t_4: 6 } } });
  const res = (await preview(ada, close('t_2'))).body;
  assert.deepEqual(res.assignments[0].table_ids, ['t_3']); // t_1 still seats 2 under a's terms
  assert.equal(a.accepted_terms.policy_version, 0);
});

test('no feasible plan is 409 and changes nothing', async () => {
  const { ada } = await world({ restaurants: [restaurant({ tables: [
    { id: 't_1', label: '1', capacity: 2 }, { id: 't_2', label: '2', capacity: 4 }] , combinable: [['t_1', 't_2']] })] });
  await book(ada, { table_id: 't_2', party_size: 4 });
  const before = await revisionNow(ada);
  expectError(await preview(ada, close('t_2')), 409, 'no_feasible_plan');
  assert.equal(await revisionNow(ada), before);
});

test('an empty closure window yields an empty plan', async () => {
  const { ada } = await world();
  const res = await preview(ada, close('t_2'));
  assert.deepEqual([res.status, res.body.assignments, res.body.moved_count, res.body.unused_seats], [201, [], 0, 0]);
});

// ---- replans: apply ---------------------------------------------------------------------------

test('preview changes nothing; apply moves, records history and closes the table', async () => {
  const { ada, bob } = await world();
  const a = (await book(bob, { table_id: 't_2', party_size: 2 })).body;
  const b = (await book(bob, { table_id: 't_1', party_size: 2 })).body;
  const rev0 = await revisionNow(ada);
  const plan = (await preview(ada, close('t_2'))).body;
  assert.equal(plan.restaurant_revision, rev0);
  assert.equal(await revisionNow(ada), rev0);
  assert.deepEqual((await call('GET', `/reservations/${a.reference}`, { token: bob })).body, a);
  const key = newKey();
  const applied = await apply(ada, plan.plan_id, key);
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal(applied.body.restaurant_revision, rev0 + 1);
  assert.deepEqual(applied.body.reservations.map((r) => r.reference), [a.reference, b.reference].sort());
  const moved = (await call('GET', `/reservations/${a.reference}`, { token: bob })).body;
  assert.deepEqual(moved.table_ids, ['t_3']);
  assert.equal(moved.revision, 2);
  assert.deepEqual([moved.starts_at, moved.ends_at, moved.party_size, moved.accepted_terms], [a.starts_at, a.ends_at, a.party_size, a.accepted_terms]);
  const entries = await history(bob, a.reference);
  assert.deepEqual(entries[1], { ...entries[1], event: 'reassigned', plan_id: plan.plan_id, revision: 2,
    changes: [{ field: 'table_ids', from: ['t_2'], to: ['t_3'] }] });
  assert.equal((await history(bob, b.reference)).length, 1);
  assert.equal((await call('GET', `/reservations/${b.reference}`, { token: bob })).body.revision, 1);
  // The closed table: unavailable, explained as no_overlap=false, and not bookable.
  const slot = (await call('GET', `/availability?restaurant_id=r_anker&date=${date}&party_size=2&explain=true`)).body
    .slots.find((s) => s.starts_at_local.endsWith('21:00'));
  const t2 = slot.explain.find((e) => e.table_id === 't_2');
  assert.deepEqual(t2.rules, [{ rule: 'capacity', holds: true }, { rule: 'no_overlap', holds: false }]);
  assert.ok(!slot.available_options.some((o) => o.table_ids.includes('t_2')));
  expectError(await book(ada, { table_id: 't_2', starts_at_local: `${date}T21:00` }), 409, 'table_unavailable');
  expectError(await book(ada, { table_id: undefined, table_ids: ['t_1', 't_2'], starts_at_local: `${date}T21:00`, party_size: 5 }), 409, 'table_unavailable');
  assert.equal((await book(ada, { table_id: 't_2', starts_at_local: `${dayPlus(8)}T19:00` })).status, 201);
  // Replays return the original response even after later changes; another key is refused.
  const replay = await apply(ada, plan.plan_id, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, applied.body);
  expectError(await apply(ada, plan.plan_id), 409, 'plan_already_applied');
});

test('stale plans, unknown plans and plans from another restaurant', async () => {
  const { ada } = await world({ restaurants: [restaurant(), restaurant({ id: 'r_two', name: 'Two' })] });
  await book(ada, { table_id: 't_2' });
  const plan = (await preview(ada, close('t_2'))).body;
  const other = (await preview(ada, close('t_2'), 'r_two')).body;
  // A booking at another restaurant does not invalidate this plan; one here does.
  await book(ada, { restaurant_id: 'r_two', table_id: 't_4' });
  expectError(await apply(ada, other.plan_id, newKey(), 'r_two'), 409, 'stale_plan');
  expectError(await apply(ada, other.plan_id, newKey(), 'r_anker'), 404, 'not_found');
  expectError(await apply(ada, 'plan_nope'), 404, 'not_found');
  const fresh = (await preview(ada, close('t_2'))).body;
  await book(ada, { table_id: 't_4', starts_at_local: `${dayPlus(9)}T19:00` });
  expectError(await apply(ada, fresh.plan_id), 409, 'stale_plan');
  expectError(await apply(ada, plan.plan_id), 409, 'stale_plan');
});

test('a closure applied at another restaurant does not invalidate this plan', async () => {
  const { ada } = await world({ restaurants: [restaurant(), restaurant({ id: 'r_two', name: 'Two' })] });
  const mine = (await preview(ada, close('t_2'))).body;
  const theirs = (await preview(ada, close('t_2'), 'r_two')).body;
  assert.equal((await apply(ada, theirs.plan_id, newKey(), 'r_two')).status, 201);
  assert.equal((await apply(ada, mine.plan_id)).status, 201);
});

test('restaurant revision: bookings, real changes, cancels, publications, adoptions, batches, plans', async () => {
  const { ada } = await world();
  assert.equal(await revisionNow(ada), 0);
  const r = (await book(ada)).body;
  assert.equal(await revisionNow(ada), 1);
  await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { party_size: 2 } }); // no-op
  expectError(await book(ada), 409, 'table_unavailable'); // failure
  assert.equal(await revisionNow(ada), 1);
  await call('PATCH', `/reservations/${r.reference}`, { token: ada, body: { party_size: 3 } });
  assert.equal(await revisionNow(ada), 2);
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: r.reference, count: 3, interval_weeks: 1 } })).body;
  assert.equal(await revisionNow(ada), 3);
  await call('POST', '/reservation-moves', { token: ada, key: newKey(), body: { moves: [
    { reference: s.occurrences[1].reference, table_id: 't_3' }, { reference: s.occurrences[2].reference, table_id: 't_3' }] } });
  assert.equal(await revisionNow(ada), 4);
  await call('POST', `/reservations/${s.occurrences[1].reference}/cancel`, { token: ada });
  await call('POST', `/reservations/${s.occurrences[1].reference}/cancel`, { token: ada });
  assert.equal(await revisionNow(ada), 5);
  await call('POST', '/restaurants/r_anker/policies', { token: ada, key: newKey(), body: {
    effective_from: dayPlus(200), slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
    opening_hours: allWeek(), capacities: { t_1: 2, t_2: 4, t_3: 6, t_4: 6 } } });
  assert.equal(await revisionNow(ada), 6);
  const plan = (await preview(ada, close('t_2'))).body;
  assert.equal((await apply(ada, plan.plan_id)).body.restaurant_revision, 7);
});

test('seating repairs move series occurrences, keep exception flags, bump series revision once', async () => {
  const { ada } = await world();
  const anchor = (await book(ada, { table_id: 't_2' })).body;
  const s = (await call('POST', '/series', { token: ada, key: newKey(), body: { anchor_reference: anchor.reference, count: 2, interval_weeks: 1 } })).body;
  await call('PATCH', `/reservations/${anchor.reference}`, { token: ada, body: { party_size: 3 } }); // anchor becomes an exception
  const plan = (await preview(ada, close('t_2'))).body;
  assert.equal(plan.moved_count, 1);
  await apply(ada, plan.plan_id);
  const cur = (await call('GET', `/series/${s.series_id}`, { token: ada })).body;
  assert.equal(cur.revision, 3); // 1 + exception PATCH + plan
  assert.deepEqual(cur.occurrences.map((o) => o.exception), [true, false]);
  assert.deepEqual(cur.occurrences[0].reservation.table_ids, ['t_3']);
  assert.equal(cur.occurrences[0].reservation.starts_at_local, anchor.starts_at_local);
});

test('concurrent applications never leave partial moves', async () => {
  const { ada } = await world();
  await book(ada, { table_id: 't_2' });
  const p1 = (await preview(ada, close('t_2'))).body;
  const p2 = (await preview(ada, close('t_2', date, '19:00', '22:00'))).body;
  const out = await Promise.all([apply(ada, p1.plan_id), apply(ada, p2.plan_id)]);
  assert.deepEqual(out.map((r) => r.status).sort(), [201, 409]);
});

// ---- series amend ---------------------------------------------------------------------------

async function seriesWorld(count = 4) {
  const tokens = await world();
  const anchor = (await book(tokens.ada)).body;
  const s = (await call('POST', '/series', { token: tokens.ada, key: newKey(), body: { anchor_reference: anchor.reference, count, interval_weeks: 1 } })).body;
  return { ...tokens, anchor, s };
}
const amend = (token, id, body, key = newKey()) => call('POST', `/series/${id}/amend`, { token, key, body });

test('series amend validation, ownership and stale revision', async () => {
  const { ada, bob, s } = await seriesWorld();
  const ok = { expected_revision: 1, from_index: 0, local_time: '20:00' };
  for (const bad of [{ expected_revision: 0 }, { expected_revision: true }, { from_index: 4 }, { from_index: -1 },
    { from_index: true }, { from_index: 1.5 }, { local_time: '8:00' }, { local_time: '24:00' }, { local_time: '20:00:00' },
    { local_time: 2000 }, { expected_revision: undefined }]) {
    expectError(await amend(ada, s.series_id, { ...ok, ...bad }), 422, 'validation_failed');
  }
  expectError(await amend(bob, s.series_id, ok), 404, 'not_found');
  expectError(await amend(ada, 'ser_nope', ok), 404, 'not_found');
  expectError(await call('POST', `/series/${s.series_id}/amend`, { key: newKey(), body: ok }), 401, 'unauthenticated');
  expectError(await call('POST', `/series/${s.series_id}/amend`, { token: ada, body: ok }), 400, 'missing_idempotency_key');
  expectError(await amend(ada, s.series_id, { ...ok, expected_revision: 2 }), 409, 'stale_revision');
});

test('series amend changes eligible occurrences on their scheduled dates', async () => {
  const { ada, s } = await seriesWorld(4);
  const refs = s.occurrences.map((o) => o.reference);
  await call('PATCH', `/reservations/${refs[2]}`, { token: ada, body: { starts_at_local: `${dayPlus(22)}T18:00` } }); // exception
  await call('POST', `/reservations/${refs[3]}/cancel`, { token: ada });
  const key = newKey();
  const res = await amend(ada, s.series_id, { expected_revision: 3, from_index: 1, local_time: '20:30', extra: true }, key);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.revision, 4);
  assert.deepEqual(res.body.occurrences.map((o) => o.reservation.starts_at_local), [
    `${date}T19:00`, `${dayPlus(14)}T20:30`, `${dayPlus(22)}T18:00`, `${dayPlus(28)}T19:00`]);
  assert.deepEqual(res.body.occurrences.map((o) => o.exception), [false, false, true, false]);
  const h = await history(ada, refs[1]);
  assert.deepEqual(h.at(-1).changes, [{ field: 'starts_at_local', from: `${dayPlus(14)}T19:00`, to: `${dayPlus(14)}T20:30` }]);
  assert.equal(res.body.occurrences[1].reservation.revision, 2);
  const replay = await amend(ada, s.series_id, { expected_revision: 3, from_index: 1, local_time: '20:30', extra: true }, key);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, res.body);
});

test('all-no-op series amend succeeds without changing revisions', async () => {
  const { ada, s } = await seriesWorld(2);
  const rev = await revisionNow(ada);
  const res = await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '19:00' });
  assert.equal(res.status, 201);
  assert.equal(res.body.revision, 1);
  assert.equal(await revisionNow(ada), rev);
  assert.ok(res.body.occurrences.every((o) => o.reservation.revision === 1));
});

test('series amend failures change nothing; non-occupancy errors win in index order', async () => {
  const { ada, bob, s } = await seriesWorld(3);
  const refs = s.occurrences.map((o) => o.reference);
  await book(bob, { starts_at_local: `${dayPlus(14)}T21:00` }); // blocks occurrence 1 at 20:30
  const key = newKey();
  expectError(await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '20:30' }, key), 409, 'table_unavailable');
  for (const ref of refs) assert.equal((await history(ada, ref)).length, 1);
  assert.equal((await call('GET', `/series/${s.series_id}`, { token: ada })).body.revision, 1);
  // 22:00 + 90 min ends after 23:00 for every occurrence: an ordinary booking error, not a conflict.
  expectError(await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '22:00' }, key), 422, 'outside_opening_hours');
  // The failed key was never claimed.
  assert.equal((await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '18:00' }, key)).status, 201);
});

test('series amend adopts each resulting date policy and does not mark exceptions', async () => {
  const { ada, s } = await seriesWorld(3);
  await call('POST', '/restaurants/r_anker/policies', { token: ada, key: newKey(), body: {
    effective_from: dayPlus(14), slot_minutes: 30, reservation_duration_minutes: 60, cancellation_cutoff_minutes: 120,
    opening_hours: allWeek(), capacities: { t_1: 2, t_2: 4, t_3: 6, t_4: 6 } } });
  const res = (await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '20:00' })).body;
  assert.deepEqual(res.occurrences.map((o) => o.reservation.accepted_terms.policy_version), [0, 1, 1]);
  assert.deepEqual(res.occurrences.map((o) => o.reservation.ends_at.slice(11, 16)), ['21:30', '21:00', '21:00']);
  assert.ok(res.occurrences.every((o) => !o.exception));
});

test('concurrent series amends from one revision: only one real change', async () => {
  const { ada, s } = await seriesWorld(2);
  const out = await Promise.all(['20:00', '21:00'].map((t) => amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: t })));
  assert.deepEqual(out.map((r) => r.status).sort(), [201, 409]);
});

test('closures block series amendments', async () => {
  const { ada, s } = await seriesWorld(2);
  const plan = (await preview(ada, close('t_2', dayPlus(14), '20:30', '23:00'))).body; // starts as occurrence 1 ends: not considered
  await apply(ada, plan.plan_id);
  expectError(await amend(ada, s.series_id, { expected_revision: 1, from_index: 0, local_time: '20:30' }), 409, 'table_unavailable');
});

test('stage-3 exports import: series amend and replans work on imported data', async () => {
  const { ada, s } = await seriesWorld(3);
  await call('PATCH', `/reservations/${s.occurrences[1].reference}`, { token: ada, body: { table_id: 't_3' } }); // exception
  await call('POST', `/reservations/${s.occurrences[2].reference}/cancel`, { token: ada });
  const exported = (await call('GET', '/_test/export')).body;
  // Shape it like a stage-3 export: no closures, plans or scheduled dates.
  delete exported.state.plans;
  for (const r of exported.state.restaurants) delete r.closures;
  for (const sr of exported.state.series) delete sr.scheduled_dates;
  await world();
  assert.equal((await call('POST', '/_test/import', { body: exported })).status, 204);
  const res = await amend(ada, s.series_id, { expected_revision: 3, from_index: 0, local_time: '20:00' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(res.body.occurrences.map((o) => o.reservation.starts_at_local),
    [`${date}T20:00`, `${dayPlus(14)}T19:00`, `${dayPlus(21)}T19:00`]);
  const plan = await preview(ada, close('t_2'));
  assert.equal(plan.status, 201);
  assert.equal((await apply(ada, plan.body.plan_id)).status, 201);
});

// ---- planning boundary and rank tie-breaks -----------------------------------------------------

test('rank vector breaks ties between equal-cost plans, in reference order', async () => {
  // Two bookings on the closed table, two identical free tables: both orders cost the same
  // moves and seats, so the lexicographically smaller rank vector (by reference) wins.
  const { ada } = await world({ restaurants: [restaurant({ tables: [
    { id: 't_1', label: '1', capacity: 4 }, { id: 't_2', label: '2', capacity: 4 }, { id: 't_3', label: '3', capacity: 4 }],
  combinable: [] })] });
  const x = (await book(ada, { table_id: 't_2', starts_at_local: `${date}T18:00` })).body;
  const y = (await book(ada, { table_id: 't_2', starts_at_local: `${date}T19:30` })).body;
  await book(ada, { table_id: 't_1', starts_at_local: `${date}T21:00` }); // fixed, outside closure, no conflict
  const res = (await preview(ada, close('t_2', date, '18:00', '21:00'))).body;
  // Neither booking overlaps the other, so each independently takes rank 0 (t_1).
  assert.deepEqual(res.assignments.map((a) => a.table_ids), [['t_1'], ['t_1']]);
  assert.deepEqual(res.assignments.map((a) => a.reference), [x.reference, y.reference].sort());
});

test('rank vector: the smaller reference gets the better-ranked table when they compete', async () => {
  const { ada } = await world({ restaurants: [restaurant({ tables: [
    { id: 't_1', label: '1', capacity: 4 }, { id: 't_2', label: '2', capacity: 4 }, { id: 't_3', label: '3', capacity: 4 },
    { id: 't_4', label: '4', capacity: 4 }], combinable: [] })] });
  const p = (await book(ada, { table_id: 't_2' })).body;
  const q = (await book(ada, { table_id: 't_4' })).body;
  // Close t_2 and t_4 in two steps: first t_4 (q moves), then plan t_2 so both compete for t_1/t_3.
  const first = (await preview(ada, close('t_4'))).body;
  await apply(ada, first.plan_id);
  const moved = (await call('GET', `/reservations/${q.reference}`, { token: ada })).body.table_ids;
  assert.deepEqual(moved, ['t_1']); // rank 0 wins, single move
  const second = (await preview(ada, close('t_2'))).body;
  assert.equal(second.moved_count, 1);
  assert.deepEqual(second.assignments.find((a) => a.reference === p.reference).table_ids, ['t_3']);
});

test('planning supports 6 tables, 4 pairs and 6 considered bookings quickly', async () => {
  const tables = Array.from({ length: 6 }, (_, i) => ({ id: `t_${i + 1}`, label: `${i + 1}`, capacity: 2 + i }));
  const combinable = [['t_1', 't_2'], ['t_2', 't_3'], ['t_3', 't_4'], ['t_5', 't_6']];
  const { ada } = await world({ restaurants: [restaurant({ tables, combinable, opening_hours: allWeek('12:00', '23:30') })] });
  const times = ['18:00', '18:00', '18:30', '18:30', '19:00', '21:00']; // the t_6 booking can move to t_1 once it frees up
  const seats = ['t_1', 't_2', 't_3', 't_4', 't_5', 't_6'];
  for (let i = 0; i < 6; i++) {
    const r = await book(ada, { table_id: seats[i], starts_at_local: `${date}T${times[i]}`, party_size: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const t0 = Date.now();
  const res = await preview(ada, close('t_6', date, '17:00', '23:00'));
  const ms = Date.now() - t0;
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.assignments.length, 6);
  assert.equal(res.body.moved_count, 1);
  assert.ok(ms < 2000, `planning took ${ms} ms`);
});

test('worst case for the search: nothing fits, every option explored, still fast', async () => {
  const tables = Array.from({ length: 6 }, (_, i) => ({ id: `t_${i + 1}`, label: `${i + 1}`, capacity: 6 }));
  const combinable = [['t_1', 't_2'], ['t_3', 't_4'], ['t_5', 't_6'], ['t_2', 't_3']];
  const { ada } = await world({ restaurants: [restaurant({ tables, combinable, opening_hours: allWeek('12:00', '23:30'), reservation_duration_minutes: 600 })] });
  for (let i = 0; i < 6; i++) {
    assert.equal((await book(ada, { table_id: `t_${i + 1}`, starts_at_local: `${date}T13:00`, party_size: 1 })).status, 201);
  }
  const t0 = Date.now();
  expectError(await preview(ada, close('t_6', date, '12:00', '23:00')), 409, 'no_feasible_plan');
  assert.ok(Date.now() - t0 < 4000, `search took ${Date.now() - t0} ms`);
});
