'use strict';
// Time-zone arithmetic on top of the ICU data bundled with Node (Intl).
// All instants are epoch milliseconds; all local wall-clock values are plain fields.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const formatters = new Map();

function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

function isValidZone(zone) {
  if (typeof zone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant in a zone.
function wallOf(ms, zone) {
  const out = {};
  for (const p of formatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

// Offset (local - UTC) in ms at an instant.
function offsetAt(ms, zone) {
  const floored = Math.floor(ms / 1000) * 1000;
  const w = wallOf(floored, zone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

// Resolve a local wall-clock time to an instant. Returns the earliest instant whose
// wall clock reads exactly that time (first occurrence on a fall-back night), or null
// when the time does not exist (skipped by a spring-forward transition).
function resolveLocal(y, mo, d, h, mi, zone) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = new Set([
    offsetAt(asUtc - DAY, zone), offsetAt(asUtc, zone), offsetAt(asUtc + DAY, zone),
  ]);
  let best = null;
  for (const off of offsets) {
    const t = asUtc - off;
    const w = wallOf(t, zone);
    if (w.y === y && w.mo === mo && w.d === d && w.h === h && w.mi === mi) {
      if (best === null || t < best) best = t;
    }
  }
  return best;
}

// Resolve a local time leniently: an existing time resolves as above; a skipped time
// maps to the instant using the offset in force before the transition (i.e. later).
function resolveLocalLenient(y, mo, d, h, mi, zone) {
  const exact = resolveLocal(y, mo, d, h, mi, zone);
  if (exact !== null) return exact;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  return asUtc - offsetAt(asUtc - DAY, zone);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function formatOffset(offMs) {
  const sign = offMs < 0 ? '-' : '+';
  const total = Math.round(Math.abs(offMs) / MINUTE);
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

// RFC 3339 with the zone's explicit offset at that instant.
function formatInstant(ms, zone) {
  const w = wallOf(ms, zone);
  const off = offsetAt(ms, zone);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${formatOffset(off)}`;
}

function formatUtc(ms) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

module.exports = {
  MINUTE, DAY, isValidZone, wallOf, offsetAt, resolveLocal, resolveLocalLenient,
  formatInstant, formatUtc, pad,
};
