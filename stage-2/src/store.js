'use strict';
// In-memory state. Every mutation runs synchronously on the single event-loop thread,
// so a check-then-write sequence inside one handler is atomic with respect to every
// other request. The only awaits in the service (password hashing) happen before
// a handler touches state.

const crypto = require('node:crypto');
const tz = require('./tz');
const v = require('./validate');
const { invalid } = require('./errors');
const { hashPassword, isHash, SEED_HASH_COST } = require('./passwords');

const TRACK = 'tablekeeper';
const FORMAT_VERSION = 1;

function emptyData() {
  return { users: [], tokens: {}, restaurants: [], reservations: [], idempotency: [] };
}

// Runtime view of the serializable `data` plus lookup indexes.
class Store {
  constructor(data) {
    this.data = data;
    this.usersById = new Map();
    this.usersByEmail = new Map();
    this.restaurantsById = new Map();
    this.tables = new Map(); // restaurant id -> Map(table id -> table)
    this.resByRef = new Map();
    this.idem = new Map();
    for (const u of data.users) this.indexUser(u);
    for (const r of data.restaurants) {
      this.restaurantsById.set(r.id, r);
      this.tables.set(r.id, new Map(r.tables.map((t) => [t.id, t])));
    }
    for (const res of data.reservations) this.resByRef.set(res.reference, res);
    for (const rec of data.idempotency) this.idem.set(idemKey(rec.user_id, rec.method, rec.path, rec.key), rec);
  }

  indexUser(u) {
    this.usersById.set(u.id, u);
    this.usersByEmail.set(u.email.toLowerCase(), u);
  }

  addUser(u) {
    this.data.users.push(u);
    this.indexUser(u);
  }

  addToken(token, userId) {
    this.data.tokens[token] = userId;
  }

  userForToken(token) {
    if (!Object.prototype.hasOwnProperty.call(this.data.tokens, token)) return null;
    return this.usersById.get(this.data.tokens[token]) || null;
  }

  table(restaurantId, tableId) {
    const t = this.tables.get(restaurantId);
    return (t && t.get(tableId)) || null;
  }

  addReservation(res) {
    this.data.reservations.push(res);
    this.resByRef.set(res.reference, res);
  }

  // Confirmed reservations holding any of `tableIds` during [start, end), minus `exclude` refs.
  overlapping(restaurantId, tableIds, start, end, exclude) {
    return this.data.reservations.filter((r) => r.status === 'confirmed'
      && r.restaurant_id === restaurantId
      && r.start_ms < end && start < r.end_ms
      && r.table_ids.some((t) => tableIds.includes(t))
      && !(exclude && exclude.has(r.reference)));
  }

  newReference() {
    for (;;) {
      const bytes = crypto.randomBytes(8);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let ref = '';
      for (const b of bytes) ref += alphabet[b % alphabet.length];
      if (!this.resByRef.has(ref)) return ref;
    }
  }

  newReservationId() {
    for (;;) {
      const id = `res_${crypto.randomBytes(8).toString('hex')}`;
      if (!this.data.reservations.some((r) => r.reservation_id === id)) return id;
    }
  }

  getIdem(userId, method, path, key) {
    return this.idem.get(idemKey(userId, method, path, key)) || null;
  }

  putIdem(rec) {
    this.data.idempotency.push(rec);
    this.idem.set(idemKey(rec.user_id, rec.method, rec.path, rec.key), rec);
  }

  export() {
    // JSON round trip: a detached, read-only snapshot taken synchronously.
    return { track: TRACK, format_version: FORMAT_VERSION, state: JSON.parse(JSON.stringify(this.data)) };
  }
}

function idemKey(userId, method, path, key) {
  return JSON.stringify([userId, method, path, key]);
}

// ---- fixtures (POST /_test/reset) ------------------------------------------

function fail(msg) {
  throw invalid(msg);
}

function validateRestaurant(r, seenIds) {
  if (!v.isObject(r)) fail('restaurant must be an object');
  if (!v.isId(r.id)) fail('restaurant id must be a string of 1..64 characters');
  if (seenIds.has(r.id)) fail(`duplicate restaurant id ${r.id}`);
  seenIds.add(r.id);
  if (typeof r.name !== 'string') fail('restaurant name must be a string');
  if (!tz.isValidZone(r.timezone)) fail('restaurant timezone must be an IANA zone name');
  if (!v.isPositiveInt(r.slot_minutes)) fail('slot_minutes must be a positive integer');
  if (!v.isPositiveInt(r.reservation_duration_minutes)) fail('reservation_duration_minutes must be a positive integer');
  if (!v.isNonNegativeInt(r.cancellation_cutoff_minutes)) fail('cancellation_cutoff_minutes must be a non-negative integer');
  if (!Array.isArray(r.opening_hours)) fail('opening_hours must be an array');
  const hours = r.opening_hours.map((h) => {
    if (!v.isObject(h)) fail('opening_hours entries must be objects');
    if (!v.WEEKDAYS.includes(h.weekday)) fail('weekday must be one of mon..sun');
    const opens = v.parseHHMM(h.opens);
    const closes = v.parseHHMM(h.closes, true);
    if (opens === null || closes === null) fail('opens/closes must be HH:MM');
    if (closes <= opens) fail('closes must be later than opens');
    return { weekday: h.weekday, opens: h.opens, closes: h.closes };
  });
  if (!Array.isArray(r.tables)) fail('tables must be an array');
  const tableIds = new Set();
  const tables = r.tables.map((t) => {
    if (!v.isObject(t)) fail('tables entries must be objects');
    if (!v.isId(t.id)) fail('table id must be a string of 1..64 characters');
    if (tableIds.has(t.id)) fail(`duplicate table id ${t.id}`);
    tableIds.add(t.id);
    if (t.label !== undefined && typeof t.label !== 'string') fail('table label must be a string');
    if (!v.isPositiveInt(t.capacity)) fail('table capacity must be a positive integer');
    return { id: t.id, label: t.label === undefined ? t.id : t.label, capacity: t.capacity };
  });
  const combinable = [];
  if (r.combinable !== undefined && r.combinable !== null) {
    if (!Array.isArray(r.combinable)) fail('combinable must be an array of table-id pairs');
    const seenPairs = new Set();
    for (const pair of r.combinable) {
      if (!Array.isArray(pair) || pair.length !== 2) fail('each combinable entry must be a pair of table ids');
      const [a, b] = pair;
      if (!tableIds.has(a) || !tableIds.has(b)) fail('combinable pairs must name tables of the restaurant');
      if (a === b) fail('a combinable pair needs two different tables');
      const key = [a, b].sort().join('\u0000');
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      combinable.push([a, b]);
    }
  }
  return {
    id: r.id,
    name: r.name,
    timezone: r.timezone,
    slot_minutes: r.slot_minutes,
    reservation_duration_minutes: r.reservation_duration_minutes,
    cancellation_cutoff_minutes: r.cancellation_cutoff_minutes,
    opening_hours: hours,
    tables,
    combinable,
  };
}

// The declared pair containing exactly tables a and b, in its declared order, or null.
function declaredPair(restaurant, a, b) {
  return restaurant.combinable.find((p) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a)) || null;
}

// Validate a table set for a restaurant. Returns { tableIds, capacity } in canonical order
// (declared order for a pair) or throws the endpoint error.
function resolveTableSet(restaurant, ids, errors) {
  if (ids.length === 0) throw errors.invalid('at least one table is required');
  if (new Set(ids).size !== ids.length) throw errors.invalid('duplicate table id in the set');
  for (const id of ids) {
    if (!v.isId(id)) throw errors.invalid('table ids must be 1..64 characters');
  }
  const tables = ids.map((id) => restaurant.tables.find((t) => t.id === id));
  if (tables.some((t) => !t)) throw errors.notFound('no such table at this restaurant');
  if (ids.length > 2) throw errors.combination('at most two tables can be combined');
  let ordered = ids;
  if (ids.length === 2) {
    const pair = declaredPair(restaurant, ids[0], ids[1]);
    if (!pair) throw errors.combination('those tables cannot be combined');
    ordered = [...pair];
  }
  return { tableIds: ordered, capacity: tables.reduce((n, t) => n + t.capacity, 0) };
}

const FIXTURE_ERRORS = { invalid: invalid, notFound: invalid, combination: invalid };

function parseTimestamp(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

async function buildFromFixture(fx) {
  if (!v.isObject(fx)) fail('fixture must be a JSON object');
  const usersIn = fx.users === undefined ? [] : fx.users;
  const restaurantsIn = fx.restaurants === undefined ? [] : fx.restaurants;
  const reservationsIn = fx.reservations === undefined || fx.reservations === null ? [] : fx.reservations;
  if (!Array.isArray(usersIn) || !Array.isArray(restaurantsIn) || !Array.isArray(reservationsIn)) {
    fail('users, restaurants and reservations must be arrays');
  }

  const userIds = new Set();
  const emails = new Set();
  for (const u of usersIn) {
    if (!v.isObject(u)) fail('users entries must be objects');
    if (!v.isId(u.id)) fail('user id must be a string of 1..64 characters');
    if (userIds.has(u.id)) fail(`duplicate user id ${u.id}`);
    userIds.add(u.id);
    if (typeof u.email !== 'string' || !v.EMAIL_RE.test(u.email)) fail('user email must be local@domain');
    const lc = u.email.toLowerCase();
    if (emails.has(lc)) fail(`duplicate email ${u.email}`);
    emails.add(lc);
    if (typeof u.password !== 'string' || u.password.length === 0) fail('user password must be a string');
    if (u.display_name !== undefined && typeof u.display_name !== 'string') fail('display_name must be a string');
  }

  const restaurantIds = new Set();
  const restaurants = restaurantsIn.map((r) => validateRestaurant(r, restaurantIds));
  const byId = new Map(restaurants.map((r) => [r.id, r]));

  const now = Date.now();
  const refs = new Set();
  const resIds = new Set();
  const reservations = reservationsIn.map((s) => {
    if (!v.isObject(s)) fail('reservations entries must be objects');
    if (!v.isId(s.id)) fail('reservation id must be a string of 1..64 characters');
    if (resIds.has(s.id)) fail(`duplicate reservation id ${s.id}`);
    resIds.add(s.id);
    if (typeof s.reference !== 'string' || !v.REFERENCE_RE.test(s.reference)) {
      fail('reference must be 6..12 characters of A-Z0-9');
    }
    if (refs.has(s.reference)) fail(`duplicate reference ${s.reference}`);
    refs.add(s.reference);
    if (!v.isId(s.user_id) || !userIds.has(s.user_id)) fail('reservation user_id must name a seeded user');
    const restaurant = v.isId(s.restaurant_id) ? byId.get(s.restaurant_id) : null;
    if (!restaurant) fail('reservation restaurant_id must name a seeded restaurant');
    if (s.table_id !== undefined && s.table_ids !== undefined) fail('send table_id or table_ids, not both');
    let ids;
    if (s.table_ids !== undefined) {
      if (!Array.isArray(s.table_ids) || !s.table_ids.every((t) => typeof t === 'string')) {
        fail('table_ids must be an array of table ids');
      }
      ids = s.table_ids;
    } else {
      if (typeof s.table_id !== 'string') fail('reservation needs table_id or table_ids');
      ids = [s.table_id];
    }
    const { tableIds } = resolveTableSet(restaurant, ids, FIXTURE_ERRORS);
    if (!v.isPositiveInt(s.party_size)) fail('party_size must be a positive integer');
    const local = v.parseLocal(s.starts_at_local);
    if (!local) fail('starts_at_local must be YYYY-MM-DDTHH:MM');
    const start = tz.resolveLocal(local.y, local.mo, local.d, local.h, local.mi, restaurant.timezone);
    if (start === null) fail('starts_at_local does not exist in the restaurant time zone');
    const status = s.status === undefined ? 'confirmed' : s.status;
    if (status !== 'confirmed' && status !== 'cancelled') fail('status must be confirmed or cancelled');
    let created = now;
    if (s.created_at !== undefined) {
      created = parseTimestamp(s.created_at);
      if (created === null) fail('created_at must be an RFC 3339 timestamp');
    }
    const end = start + restaurant.reservation_duration_minutes * tz.MINUTE;
    return {
      reservation_id: s.id,
      reference: s.reference,
      user_id: s.user_id,
      restaurant_id: restaurant.id,
      table_ids: tableIds,
      party_size: s.party_size,
      status,
      starts_at_local: s.starts_at_local,
      starts_at: tz.formatInstant(start, restaurant.timezone),
      ends_at: tz.formatInstant(end, restaurant.timezone),
      created_at: tz.formatUtc(created),
      start_ms: start,
      end_ms: end,
    };
  });

  // The no-double-booking invariant holds for seeded data too.
  const confirmed = reservations.filter((r) => r.status === 'confirmed');
  for (let i = 0; i < confirmed.length; i++) {
    for (let j = i + 1; j < confirmed.length; j++) {
      const a = confirmed[i], b = confirmed[j];
      if (a.restaurant_id === b.restaurant_id && a.table_ids.some((t) => b.table_ids.includes(t))
        && a.start_ms < b.end_ms && b.start_ms < a.end_ms) {
        fail(`seeded reservations ${a.reference} and ${b.reference} overlap on one table`);
      }
    }
  }

  const users = await Promise.all(usersIn.map(async (u) => ({
    id: u.id,
    email: u.email,
    display_name: u.display_name === undefined ? '' : u.display_name,
    password_hash: await hashPassword(u.password, SEED_HASH_COST),
  })));

  return new Store({ users, tokens: {}, restaurants, reservations, idempotency: [] });
}

// ---- import (POST /_test/import) -------------------------------------------

function check(cond, msg) {
  if (!cond) fail(msg);
}

const STRING_FIELDS = ['reservation_id', 'reference', 'user_id', 'restaurant_id',
  'starts_at_local', 'starts_at', 'ends_at', 'created_at'];

function buildFromExport(doc) {
  check(v.isObject(doc), 'import body must be an object');
  check(doc.track === TRACK, 'track must be "tablekeeper"');
  check(doc.format_version === FORMAT_VERSION, 'format_version must be 1');
  const s = doc.state;
  check(v.isObject(s), 'state must be an object');
  for (const k of ['users', 'restaurants', 'reservations', 'idempotency']) {
    check(Array.isArray(s[k]), `state.${k} must be an array`);
  }
  check(v.isObject(s.tokens), 'state.tokens must be an object');

  const userIds = new Set();
  const emails = new Set();
  for (const u of s.users) {
    check(v.isObject(u) && v.isId(u.id) && !userIds.has(u.id), 'invalid user');
    check(typeof u.email === 'string' && v.EMAIL_RE.test(u.email), 'invalid user email');
    check(!emails.has(u.email.toLowerCase()), 'duplicate user email');
    check(typeof u.display_name === 'string', 'invalid display_name');
    check(isHash(u.password_hash), 'invalid password hash');
    userIds.add(u.id);
    emails.add(u.email.toLowerCase());
  }
  for (const [token, uid] of Object.entries(s.tokens)) {
    check(token.length > 0 && typeof uid === 'string' && userIds.has(uid), 'invalid token');
  }
  const restaurantIds = new Set();
  const restaurants = s.restaurants.map((r) => validateRestaurant(r, restaurantIds));
  const byId = new Map(restaurants.map((r) => [r.id, r]));

  const refs = new Set();
  const reservations = s.reservations.map((r) => {
    check(v.isObject(r), 'invalid reservation');
    // Stage-1 exports hold a single `table_id`; stage 2 stores a set.
    if (r.table_ids === undefined && typeof r.table_id === 'string') {
      const { table_id: tableId, ...rest } = r;
      return { ...rest, table_ids: [tableId] };
    }
    const { table_id: _ignored, ...rest } = r;
    return rest;
  });
  for (const r of reservations) {
    for (const f of STRING_FIELDS) check(typeof r[f] === 'string', `reservation.${f} must be a string`);
    check(v.REFERENCE_RE.test(r.reference) && !refs.has(r.reference), 'invalid reservation reference');
    refs.add(r.reference);
    check(userIds.has(r.user_id), 'reservation user unknown');
    const rest = byId.get(r.restaurant_id);
    check(rest && Array.isArray(r.table_ids) && r.table_ids.length >= 1 && r.table_ids.length <= 2
      && new Set(r.table_ids).size === r.table_ids.length
      && r.table_ids.every((id) => rest.tables.some((t) => t.id === id)), 'reservation tables unknown');
    check(r.status === 'confirmed' || r.status === 'cancelled', 'invalid reservation status');
    check(v.isPositiveInt(r.party_size), 'invalid party_size');
    check(Number.isSafeInteger(r.start_ms) && Number.isSafeInteger(r.end_ms) && r.end_ms > r.start_ms,
      'invalid reservation interval');
  }
  for (const rec of s.idempotency) {
    check(v.isObject(rec) && userIds.has(rec.user_id), 'invalid idempotency record');
    check(typeof rec.method === 'string' && typeof rec.path === 'string' && typeof rec.key === 'string'
      && typeof rec.fingerprint === 'string', 'invalid idempotency record');
    check(v.isObject(rec.response), 'invalid idempotency response');
  }
  // Rebuilt from a validated deep copy so nothing aliases the request body.
  const data = JSON.parse(JSON.stringify({ ...s, restaurants, reservations }));
  return new Store({
    users: data.users, tokens: data.tokens, restaurants: data.restaurants,
    reservations: data.reservations, idempotency: data.idempotency,
  });
}

module.exports = {
  Store, emptyData, buildFromFixture, buildFromExport, resolveTableSet, declaredPair, TRACK, FORMAT_VERSION,
};
