'use strict';
// Dated booking policies (stage 3). Policy 0 is the restaurant's fixture configuration;
// published policies are immutable and selected per local booking date.

const v = require('./validate');
const { invalid } = require('./errors');

// The fixture rules as a policy.
function policyZero(restaurant) {
  return {
    policy_version: 0,
    effective_from: null,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: restaurant.opening_hours.map((h) => ({ ...h })),
    capacities: Object.fromEntries(restaurant.tables.map((t) => [t.id, t.capacity])),
  };
}

// The policy for a local calendar date `YYYY-MM-DD`: greatest effective_from not later
// than the date, ties broken by the greatest policy_version; policy 0 otherwise.
function selectPolicy(restaurant, date) {
  let best = null;
  for (const p of restaurant.policies) {
    if (p.effective_from > date) continue;
    if (!best || p.effective_from > best.effective_from
      || (p.effective_from === best.effective_from && p.policy_version > best.policy_version)) {
      best = p;
    }
  }
  return best || policyZero(restaurant);
}

// The accepted-terms snapshot of a policy: everything except effective_from.
function termsOf(policy) {
  return {
    policy_version: policy.policy_version,
    slot_minutes: policy.slot_minutes,
    reservation_duration_minutes: policy.reservation_duration_minutes,
    cancellation_cutoff_minutes: policy.cancellation_cutoff_minutes,
    opening_hours: policy.opening_hours.map((h) => ({ ...h })),
    capacities: { ...policy.capacities },
  };
}

// The public shape of a published policy.
function policyView(p) {
  return {
    effective_from: p.effective_from,
    slot_minutes: p.slot_minutes,
    reservation_duration_minutes: p.reservation_duration_minutes,
    cancellation_cutoff_minutes: p.cancellation_cutoff_minutes,
    opening_hours: p.opening_hours.map((h) => ({ ...h })),
    capacities: { ...p.capacities },
    policy_version: p.policy_version,
  };
}

const isInt = (x) => typeof x === 'number' && Number.isSafeInteger(x);
const inRange = (x, lo, hi) => isInt(x) && x >= lo && x <= hi;

// Validate a complete policy body for a restaurant. Every problem is 422 validation_failed.
function parsePolicy(body, restaurant) {
  const fail = (m) => { throw invalid(m); };
  const required = ['effective_from', 'slot_minutes', 'reservation_duration_minutes',
    'cancellation_cutoff_minutes', 'opening_hours', 'capacities'];
  for (const f of required) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) fail(`${f} is required`);
  }
  if (!v.parseDate(body.effective_from)) fail('effective_from must be a YYYY-MM-DD date');
  if (!inRange(body.slot_minutes, 1, 1440)) fail('slot_minutes must be an integer 1..1440');
  if (!inRange(body.reservation_duration_minutes, 1, 1440)) {
    fail('reservation_duration_minutes must be an integer 1..1440');
  }
  if (!inRange(body.cancellation_cutoff_minutes, 0, 10080)) {
    fail('cancellation_cutoff_minutes must be an integer 0..10080');
  }
  if (!Array.isArray(body.opening_hours)) fail('opening_hours must be an array');
  const weekdays = new Set();
  const hours = body.opening_hours.map((h) => {
    if (!v.isObject(h)) fail('opening_hours entries must be objects');
    if (!v.WEEKDAYS.includes(h.weekday)) fail('weekday must be one of mon..sun');
    if (weekdays.has(h.weekday)) fail('opening_hours must not repeat a weekday');
    weekdays.add(h.weekday);
    const opens = v.parseHHMM(h.opens);
    const closes = v.parseHHMM(h.closes, true);
    if (opens === null || closes === null) fail('opens/closes must be HH:MM');
    if (closes <= opens) fail('closes must be later than opens');
    return { weekday: h.weekday, opens: h.opens, closes: h.closes };
  });
  if (!v.isObject(body.capacities)) fail('capacities must be an object');
  const ids = restaurant.tables.map((t) => t.id);
  const given = Object.keys(body.capacities);
  if (given.length !== ids.length || !ids.every((id) => Object.prototype.hasOwnProperty.call(body.capacities, id))) {
    fail("capacities must name exactly the restaurant's tables");
  }
  const capacities = {};
  for (const id of ids) {
    if (!inRange(body.capacities[id], 1, 100)) fail('capacities must be integers 1..100');
    capacities[id] = body.capacities[id];
  }
  return {
    effective_from: body.effective_from,
    slot_minutes: body.slot_minutes,
    reservation_duration_minutes: body.reservation_duration_minutes,
    cancellation_cutoff_minutes: body.cancellation_cutoff_minutes,
    opening_hours: hours,
    capacities,
  };
}

module.exports = { policyZero, selectPolicy, termsOf, policyView, parsePolicy };
