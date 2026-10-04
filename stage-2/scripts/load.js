'use strict';
// Load probe run INSIDE the container (it has no network): 50 requests in flight.
// Usage: docker exec -i <container> node - < scripts/load.js
const base = `http://127.0.0.1:${process.env.PORT || 8080}`;
const hours = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({ weekday, opens: '18:00', closes: '23:00' }));
const users = Array.from({ length: 50 }, (_, i) => ({ id: `u_${i}`, email: `u${i}@example.com`, password: 'correct horse', display_name: `U${i}` }));
const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

async function req(method, path, { body, token, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const t0 = Date.now();
  const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - t0, body: text ? JSON.parse(text) : null };
}

(async () => {
  let t0 = Date.now();
  const reset = await fetch(`${base}/_test/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ users, restaurants: [{ id: 'r', name: 'R', timezone: 'Europe/Berlin', slot_minutes: 30,
      reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120, opening_hours: hours,
      tables: [{ id: 't', label: 't', capacity: 4 }] }] }),
  });
  console.log(`reset 50 users: ${reset.status} in ${Date.now() - t0} ms`);
  t0 = Date.now();
  const logins = await Promise.all(users.map((u) => req('POST', '/auth/login', { body: { email: u.email, password: u.password } })));
  console.log(`50 concurrent logins: statuses ${[...new Set(logins.map((r) => r.status))]} max ${Math.max(...logins.map((r) => r.ms))} ms, wall ${Date.now() - t0} ms`);
  const tokens = logins.map((r) => r.body.token);
  const body = { restaurant_id: 'r', table_id: 't', starts_at_local: `${date}T19:00`, party_size: 2 };
  t0 = Date.now();
  const race = await Promise.all(tokens.map((token, i) => req('POST', '/reservations', { token, key: `k${i}`, body })));
  const tally = {};
  for (const r of race) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log(`50 racers for one table: ${JSON.stringify(tally)} max ${Math.max(...race.map((r) => r.ms))} ms`);
  const replays = await Promise.all(Array.from({ length: 20 }, () => req('POST', '/reservations', { token: tokens[0], key: 'same', body: { ...body, starts_at_local: `${date}T21:00` } })));
  const rt = {};
  for (const r of replays) rt[r.status] = (rt[r.status] || 0) + 1;
  console.log(`20 concurrent same-key requests: ${JSON.stringify(rt)}`);
  const mixed = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2
    ? req('GET', `/availability?restaurant_id=r&date=${date}&party_size=2`)
    : req('GET', '/reservations', { token: tokens[i] }))));
  console.log(`50 mixed reads: statuses ${[...new Set(mixed.map((r) => r.status))]} max ${Math.max(...mixed.map((r) => r.ms))} ms`);
  const bad = [...logins, ...race, ...replays, ...mixed].filter((r) => r.status >= 500).length;
  const ok = reset.status === 204 && tally[201] === 1 && tally[409] === 49 && rt[201] === 1 && rt[200] === 19 && bad === 0;
  console.log(ok ? 'LOAD OK' : 'LOAD FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
