'use strict';
// Request handlers. Each handler receives a request context and returns
// { status, body } or throws an ApiError.

const crypto = require('node:crypto');
const tz = require('./tz');
const v = require('./validate');
const { ApiError, malformed, invalid, notFound, unauthenticated } = require('./errors');
const { hashPassword, verifyPassword } = require('./passwords');
const { Store, emptyData, buildFromFixture, buildFromExport, resolveTableSet } = require('./store');
const ui = require('./ui');

const state = { store: new Store(emptyData()), arrivals: 0, applied: 0 };

// Replace the whole state. `seq` is the arrival order of the reset/import that built
// it: a slow reset that arrives earlier never overwrites a later one.
function replaceStore(store, seq) {
  if (seq < state.applied) return;
  state.applied = seq;
  state.store = store;
}

const MAX_KEY_LENGTH = 255;
const MAX_MOVES = 8;

// ---- helpers ---------------------------------------------------------------

function parseBody(ctx) {
  if (ctx.parsed !== undefined) return ctx.parsed;
  let body;
  try {
    body = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    throw malformed('request body is not valid JSON');
  }
  if (!v.isObject(body)) throw malformed('request body must be a JSON object');
  ctx.parsed = body;
  return body;
}

function requireUser(ctx) {
  const header = ctx.headers.authorization;
  const m = typeof header === 'string' ? /^Bearer +(\S+) *$/i.exec(header) : null;
  if (!m) throw unauthenticated('missing or malformed bearer token');
  const user = state.store.userForToken(m[1]);
  if (!user) throw unauthenticated('unknown bearer token');
  return user;
}

function idempotencyKey(ctx) {
  const key = ctx.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new ApiError(400, 'missing_idempotency_key', 'Idempotency-Key header is required');
  }
  if ([...key].length > MAX_KEY_LENGTH) throw invalid('Idempotency-Key must be 1..255 characters');
  return key;
}

// Canonical JSON: same value regardless of key order and whitespace.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (v.isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Resolve idempotency for a write before any field validation (§7).
// Returns a replay response, or a function that records a successful result.
function idempotent(ctx, user, body) {
  const key = idempotencyKey(ctx);
  const fingerprint = canonical(body);
  const store = state.store;
  const rec = store.getIdem(user.id, ctx.method, ctx.path, key);
  if (rec) {
    if (rec.fingerprint !== fingerprint) {
      throw new ApiError(409, 'idempotency_key_reuse', 'Idempotency-Key was used with a different body');
    }
    return { replay: { status: 200, body: rec.response } };
  }
  return {
    record(status, response) {
      store.putIdem({ user_id: user.id, method: ctx.method, path: ctx.path, key, fingerprint, response });
      return { status, body: response };
    },
  };
}

// A present field of the wrong JSON type is a malformed request (§5).
function requireStringType(obj, field) {
  if (Object.prototype.hasOwnProperty.call(obj, field) && typeof obj[field] !== 'string') {
    throw malformed(`${field} must be a string`);
  }
}

function validPartySize(value) {
  if (!v.isPositiveInt(value)) throw invalid('party_size must be an integer of at least 1');
  return value;
}

function validLocal(value) {
  const local = v.parseLocal(value);
  if (!local) throw invalid('starts_at_local must be a bare local YYYY-MM-DDTHH:MM');
  return local;
}

function validIdField(value, field) {
  if (!v.isId(value)) throw invalid(`${field} must be 1..64 characters`);
  return value;
}

const TABLE_SET_ERRORS = {
  invalid,
  notFound,
  combination: (m) => new ApiError(422, 'combination_not_allowed', m),
};

// The table set named by `table_id` or `table_ids` in a body, or null when neither is present.
function tableSetFromBody(obj) {
  const hasOne = Object.prototype.hasOwnProperty.call(obj, 'table_id');
  const hasMany = Object.prototype.hasOwnProperty.call(obj, 'table_ids');
  if (hasMany && (!Array.isArray(obj.table_ids) || obj.table_ids.some((t) => typeof t !== 'string'))) {
    throw malformed('table_ids must be an array of strings');
  }
  if (hasOne && hasMany) throw invalid('send table_id or table_ids, not both');
  if (hasMany) return obj.table_ids;
  if (hasOne) return [obj.table_id];
  return null;
}

function view(r) {
  const out = {
    reservation_id: r.reservation_id,
    reference: r.reference,
    restaurant_id: r.restaurant_id,
  };
  if (r.table_ids.length === 1) out.table_id = r.table_ids[0];
  Object.assign(out, {
    table_ids: [...r.table_ids],
    party_size: r.party_size,
    status: r.status,
    starts_at_local: r.starts_at_local,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    created_at: r.created_at,
  });
  return out;
}

function minutesLabel(m) {
  return `${tz.pad(Math.floor(m / 60))}:${tz.pad(m % 60)}`;
}

function localString(date, minutes) {
  return `${tz.pad(date.y, 4)}-${tz.pad(date.mo)}-${tz.pad(date.d)}T${minutesLabel(minutes)}`;
}

// Instant at which an opening-hours entry closes on a given local date.
function closingInstant(date, closesMinutes, zone) {
  if (closesMinutes >= 24 * 60) {
    const next = new Date(Date.UTC(date.y, date.mo - 1, date.d + 1));
    return tz.resolveLocalLenient(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, zone);
  }
  return tz.resolveLocalLenient(date.y, date.mo, date.d, Math.floor(closesMinutes / 60), closesMinutes % 60, zone);
}

function hoursFor(restaurant, date) {
  const weekday = v.weekdayOf(date);
  return restaurant.opening_hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ opens: v.parseHHMM(h.opens), closes: v.parseHHMM(h.closes, true) }))
    .sort((a, b) => a.opens - b.opens);
}

// Booking rules for a start time: existence (DST), opening hours, slot grid, closing.
function resolveSlot(restaurant, local) {
  const zone = restaurant.timezone;
  const start = tz.resolveLocal(local.y, local.mo, local.d, local.h, local.mi, zone);
  if (start === null) {
    throw new ApiError(422, 'invalid_local_time', 'that local time does not exist in the restaurant time zone');
  }
  const minute = local.h * 60 + local.mi;
  const entry = hoursFor(restaurant, local).find((h) => h.opens <= minute && minute < h.closes);
  if (!entry) throw new ApiError(422, 'outside_opening_hours', 'the restaurant is closed at that time');
  if ((minute - entry.opens) % restaurant.slot_minutes !== 0) {
    throw new ApiError(422, 'not_on_slot_grid', 'starts_at_local is not on the slot grid');
  }
  const end = start + restaurant.reservation_duration_minutes * tz.MINUTE;
  if (end > closingInstant(local, entry.closes, zone)) {
    throw new ApiError(422, 'outside_opening_hours', 'the reservation would end after closing');
  }
  return { start, end };
}

function cutoffPassed(restaurant, reservation, now) {
  return now >= reservation.start_ms - restaurant.cancellation_cutoff_minutes * tz.MINUTE;
}

function ownReservation(user, reference) {
  const r = state.store.resByRef.get(reference);
  if (!r || r.user_id !== user.id) throw notFound('no such reservation');
  return r;
}

// Validate an amendment of `r` by the PATCH fields in `fields`, without applying it.
function planAmendment(r, fields, now) {
  if (r.status === 'cancelled') {
    throw new ApiError(409, 'reservation_cancelled', 'the reservation is cancelled');
  }
  const restaurant = state.store.restaurantsById.get(r.restaurant_id);
  if (cutoffPassed(restaurant, r, now)) {
    throw new ApiError(409, 'cutoff_passed', 'too close to the reservation start to change it');
  }
  const has = (f) => Object.prototype.hasOwnProperty.call(fields, f);
  const partySize = has('party_size') ? validPartySize(fields.party_size) : r.party_size;
  const local = has('starts_at_local') ? validLocal(fields.starts_at_local) : null;
  const requested = tableSetFromBody(fields);
  const { tableIds, capacity } = resolveTableSet(restaurant, requested || r.table_ids, TABLE_SET_ERRORS);
  let start = r.start_ms, end = r.end_ms, startsAtLocal = r.starts_at_local;
  if (local) {
    ({ start, end } = resolveSlot(restaurant, local));
    startsAtLocal = fields.starts_at_local;
  }
  if (partySize > capacity) {
    throw new ApiError(422, 'party_exceeds_capacity', 'party_size exceeds the table capacity');
  }
  return { r, restaurant, tableIds, partySize, start, end, startsAtLocal };
}

function applyPlan(p) {
  const zone = p.restaurant.timezone;
  Object.assign(p.r, {
    table_ids: p.tableIds,
    party_size: p.partySize,
    starts_at_local: p.startsAtLocal,
    start_ms: p.start,
    end_ms: p.end,
    starts_at: tz.formatInstant(p.start, zone),
    ends_at: tz.formatInstant(p.end, zone),
  });
}

function tableUnavailable() {
  return new ApiError(409, 'table_unavailable', 'the table is taken for an overlapping time');
}

// ---- handlers --------------------------------------------------------------

function health() {
  return { status: 200, body: { status: 'ok' } };
}

async function reset(ctx) {
  const seq = ++state.arrivals;
  const fixture = parseBody(ctx);
  replaceStore(await buildFromFixture(fixture), seq);
  return { status: 204 };
}

function exportState() {
  return { status: 200, body: state.store.export() };
}

function importState(ctx) {
  const seq = ++state.arrivals;
  const doc = parseBody(ctx);
  replaceStore(buildFromExport(doc), seq);
  return { status: 204 };
}

function authResponse(user, store) {
  const token = `tk_${crypto.randomBytes(24).toString('hex')}`;
  store.addToken(token, user.id);
  return { user_id: user.id, display_name: user.display_name, token };
}

async function signup(ctx) {
  const body = parseBody(ctx);
  for (const f of ['email', 'password', 'display_name']) requireStringType(body, f);
  const { email, password } = body;
  if (email === undefined || password === undefined || body.display_name === undefined) {
    throw invalid('email, password and display_name are required');
  }
  if (!v.EMAIL_RE.test(email) || email.length > 254) throw invalid('email must be of the form local@domain');
  if ([...password].length < 8) throw invalid('password must be at least 8 characters');
  if (state.store.usersByEmail.has(email.toLowerCase())) {
    throw new ApiError(409, 'email_taken', 'that email is already registered');
  }
  const hash = await hashPassword(password);
  const store = state.store; // re-read after the await: checks below are atomic
  if (store.usersByEmail.has(email.toLowerCase())) {
    throw new ApiError(409, 'email_taken', 'that email is already registered');
  }
  let id;
  do id = `u_${crypto.randomBytes(8).toString('hex')}`; while (store.usersById.has(id));
  const user = { id, email, display_name: body.display_name, password_hash: hash };
  store.addUser(user);
  return { status: 201, body: authResponse(user, store) };
}

async function login(ctx) {
  const body = parseBody(ctx);
  for (const f of ['email', 'password']) requireStringType(body, f);
  if (body.email === undefined || body.password === undefined) throw invalid('email and password are required');
  const store = state.store;
  const user = store.usersByEmail.get(body.email.toLowerCase());
  if (!user) throw unauthenticated('wrong email or password');
  const ok = await verifyPassword(body.password, user.password_hash);
  // A reset or import that landed during the hash check invalidates this attempt.
  if (!ok || state.store !== store) throw unauthenticated('wrong email or password');
  return { status: 200, body: authResponse(user, store) };
}

function listRestaurants() {
  return {
    status: 200,
    body: { restaurants: state.store.data.restaurants.map((r) => ({ id: r.id, name: r.name, timezone: r.timezone })) },
  };
}

function getRestaurant(ctx) {
  const r = state.store.restaurantsById.get(ctx.params.id);
  if (!r) throw notFound('no such restaurant');
  return {
    status: 200,
    body: {
      id: r.id,
      name: r.name,
      timezone: r.timezone,
      slot_minutes: r.slot_minutes,
      reservation_duration_minutes: r.reservation_duration_minutes,
      cancellation_cutoff_minutes: r.cancellation_cutoff_minutes,
      opening_hours: r.opening_hours.map((h) => ({ ...h })),
      tables: r.tables.map((t) => ({ ...t })),
      combinable: r.combinable.map((p) => [...p]),
    },
  };
}

function availability(ctx) {
  const q = ctx.query;
  for (const p of ['restaurant_id', 'date', 'party_size']) {
    if (q[p] === undefined) throw invalid(`${p} is required`);
  }
  validIdField(q.restaurant_id, 'restaurant_id');
  const date = v.parseDate(q.date);
  if (!date) throw invalid('date must be a valid YYYY-MM-DD');
  const partySize = v.parseQueryInt(q.party_size);
  if (partySize === null || partySize < 1) throw invalid('party_size must be a positive integer');

  const store = state.store;
  const restaurant = store.restaurantsById.get(q.restaurant_id);
  if (!restaurant) throw notFound('no such restaurant');
  const zone = restaurant.timezone;
  const duration = restaurant.reservation_duration_minutes * tz.MINUTE;
  const slots = [];
  const seen = new Set();
  for (const entry of hoursFor(restaurant, date)) {
    const close = closingInstant(date, entry.closes, zone);
    for (let m = entry.opens; m < entry.closes; m += restaurant.slot_minutes) {
      const local = localString(date, m);
      if (seen.has(local)) continue;
      const start = tz.resolveLocal(date.y, date.mo, date.d, Math.floor(m / 60), m % 60, zone);
      if (start === null) continue; // skipped by spring-forward
      const end = start + duration;
      if (end > close) continue;
      seen.add(local);
      const free = new Set(restaurant.tables
        .filter((t) => store.overlapping(restaurant.id, [t.id], start, end).length === 0)
        .map((t) => t.id));
      const singles = restaurant.tables.filter((t) => free.has(t.id) && t.capacity >= partySize);
      const options = singles.map((t) => ({ table_ids: [t.id], capacity: t.capacity }));
      for (const pair of restaurant.combinable) {
        const capacity = pair.reduce((n, id) => n + store.table(restaurant.id, id).capacity, 0);
        if (capacity >= partySize && pair.every((id) => free.has(id))) {
          options.push({ table_ids: [...pair], capacity });
        }
      }
      slots.push({
        starts_at_local: local,
        starts_at: tz.formatInstant(start, zone),
        available_table_ids: singles.map((t) => t.id),
        available_options: options,
      });
    }
  }
  return {
    status: 200,
    body: { restaurant_id: restaurant.id, date: q.date, timezone: zone, slots },
  };
}

function createReservation(ctx) {
  const user = requireUser(ctx);
  const body = parseBody(ctx);
  const idem = idempotent(ctx, user, body);
  if (idem.replay) return idem.replay;

  for (const f of ['restaurant_id', 'table_id', 'starts_at_local']) requireStringType(body, f);
  const requested = tableSetFromBody(body);
  const has = (f) => Object.prototype.hasOwnProperty.call(body, f);
  if (!has('restaurant_id') || !requested || !has('starts_at_local') || !has('party_size')) {
    throw invalid('restaurant_id, table_id or table_ids, starts_at_local and party_size are required');
  }
  const partySize = validPartySize(body.party_size);
  const local = validLocal(body.starts_at_local);
  validIdField(body.restaurant_id, 'restaurant_id');

  const store = state.store;
  const restaurant = store.restaurantsById.get(body.restaurant_id);
  if (!restaurant) throw notFound('no such restaurant');
  const { tableIds, capacity } = resolveTableSet(restaurant, requested, TABLE_SET_ERRORS);
  const { start, end } = resolveSlot(restaurant, local);
  if (partySize > capacity) {
    throw new ApiError(422, 'party_exceeds_capacity', 'party_size exceeds the table capacity');
  }
  if (store.overlapping(restaurant.id, tableIds, start, end).length > 0) throw tableUnavailable();

  const zone = restaurant.timezone;
  const reservation = {
    reservation_id: store.newReservationId(),
    reference: store.newReference(),
    user_id: user.id,
    restaurant_id: restaurant.id,
    table_ids: tableIds,
    party_size: partySize,
    status: 'confirmed',
    starts_at_local: body.starts_at_local,
    starts_at: tz.formatInstant(start, zone),
    ends_at: tz.formatInstant(end, zone),
    created_at: tz.formatUtc(Date.now()),
    start_ms: start,
    end_ms: end,
  };
  store.addReservation(reservation);
  return idem.record(201, view(reservation));
}

function listReservations(ctx) {
  const user = requireUser(ctx);
  const mine = state.store.data.reservations
    .filter((r) => r.user_id === user.id)
    .sort((a, b) => b.start_ms - a.start_ms || (a.created_at < b.created_at ? 1 : -1));
  return { status: 200, body: { reservations: mine.map(view) } };
}

function getReservation(ctx) {
  const user = requireUser(ctx);
  return { status: 200, body: view(ownReservation(user, ctx.params.reference)) };
}

function cancelReservation(ctx) {
  const user = requireUser(ctx);
  const r = ownReservation(user, ctx.params.reference);
  if (r.status === 'cancelled') return { status: 200, body: view(r) };
  const restaurant = state.store.restaurantsById.get(r.restaurant_id);
  if (cutoffPassed(restaurant, r, Date.now())) {
    throw new ApiError(409, 'cutoff_passed', 'too close to the reservation start to cancel it');
  }
  r.status = 'cancelled';
  r.cancelled_at = tz.formatUtc(Date.now());
  return { status: 200, body: view(r) };
}

function amendReservation(ctx) {
  const user = requireUser(ctx);
  const body = parseBody(ctx);
  for (const f of ['table_id', 'starts_at_local']) requireStringType(body, f);
  tableSetFromBody(body);
  const r = ownReservation(user, ctx.params.reference);
  const plan = planAmendment(r, body, Date.now());
  const clash = state.store.overlapping(r.restaurant_id, plan.tableIds, plan.start, plan.end, new Set([r.reference]));
  if (clash.length > 0) throw tableUnavailable();
  applyPlan(plan);
  return { status: 200, body: view(r) };
}

function moveReservations(ctx) {
  const user = requireUser(ctx);
  const body = parseBody(ctx);
  const idem = idempotent(ctx, user, body);
  if (idem.replay) return idem.replay;

  const { moves } = body;
  if (!Array.isArray(moves) || moves.length < 1 || moves.length > MAX_MOVES) {
    throw invalid(`moves must be an array of 1..${MAX_MOVES} items`);
  }
  const refs = new Set();
  for (const item of moves) {
    if (!v.isObject(item) || typeof item.reference !== 'string' || item.reference.length === 0) {
      throw invalid('each move must be an object with a string reference');
    }
    if (refs.has(item.reference)) throw invalid('references in moves must be distinct');
    refs.add(item.reference);
  }
  for (const item of moves) {
    for (const f of ['table_id', 'starts_at_local']) requireStringType(item, f);
    tableSetFromBody(item);
  }
  const bookings = moves.map((item) => ownReservation(user, item.reference));
  if (bookings.some((b) => b.restaurant_id !== bookings[0].restaurant_id)) {
    throw invalid('all moved bookings must belong to the same restaurant');
  }
  const now = Date.now();
  const plans = moves.map((item, i) => planAmendment(bookings[i], item, now));

  const store = state.store;
  for (const p of plans) {
    if (store.overlapping(p.r.restaurant_id, p.tableIds, p.start, p.end, refs).length > 0) throw tableUnavailable();
  }
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i], b = plans[j];
      if (a.tableIds.some((t) => b.tableIds.includes(t)) && a.start < b.end && b.start < a.end) {
        throw tableUnavailable();
      }
    }
  }
  plans.forEach(applyPlan);
  return idem.record(201, { reservations: bookings.map(view) });
}

// ---- routing -----------------------------------------------------------------

const routes = [
  ['GET', /^\/$/, [], (ctx) => ui.page(ctx, state.store)],
  ['GET', /^\/(signup|login|lookup)$/, ['screen'], (ctx) => ui.page(ctx, state.store)],
  ['GET', /^\/assets\/([A-Za-z0-9_.-]+)$/, ['name'], (ctx) => ui.asset(ctx)],
  ['GET', /^\/health$/, [], health],
  ['POST', /^\/_test\/reset$/, [], reset],
  ['GET', /^\/_test\/export$/, [], exportState],
  ['POST', /^\/_test\/import$/, [], importState],
  ['POST', /^\/auth\/signup$/, [], signup],
  ['POST', /^\/auth\/login$/, [], login],
  ['GET', /^\/restaurants$/, [], listRestaurants],
  ['GET', /^\/restaurants\/([^/]+)$/, ['id'], getRestaurant],
  ['GET', /^\/availability$/, [], availability],
  ['POST', /^\/reservations$/, [], createReservation],
  ['GET', /^\/reservations$/, [], listReservations],
  ['GET', /^\/reservations\/([^/]+)$/, ['reference'], getReservation],
  ['PATCH', /^\/reservations\/([^/]+)$/, ['reference'], amendReservation],
  ['POST', /^\/reservations\/([^/]+)\/cancel$/, ['reference'], cancelReservation],
  ['POST', /^\/reservation-moves$/, [], moveReservations],
];

function route(method, path) {
  let pathMatched = false;
  for (const [m, re, names, handler] of routes) {
    const match = re.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (m !== method) continue;
    const params = {};
    names.forEach((n, i) => { params[n] = match[i + 1]; });
    return { handler, params };
  }
  return { pathMatched };
}

module.exports = { route, state, canonical };
