'use strict';
// Shared input validators. Each returns a parsed value or null; callers pick the error.

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MAX_ID = 64;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ID;
const REFERENCE_RE = /^[A-Z0-9]{6,12}$/;

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// YYYY-MM-DD -> {y, mo, d}
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, mo, d };
}

// HH:MM -> minutes since midnight. `allow24` accepts 24:00 (end of day) for closing times.
function parseHHMM(s, allow24 = false) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (allow24 && h === 24 && mi === 0) return 24 * 60;
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Bare local YYYY-MM-DDTHH:MM -> {y, mo, d, h, mi}
function parseLocal(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  const date = parseDate(m[1]);
  const minutes = parseHHMM(m[2]);
  if (!date || minutes === null) return null;
  return { ...date, h: Math.floor(minutes / 60), mi: minutes % 60 };
}

function weekdayOf({ y, mo, d }) {
  // getUTCDay: 0 = Sunday
  return WEEKDAYS[(new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7];
}

const isPositiveInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isNonNegativeInt = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

// Integer query parameter: plain decimal digits only.
function parseQueryInt(s) {
  if (typeof s !== 'string' || !/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

module.exports = {
  WEEKDAYS, MAX_ID, REFERENCE_RE, EMAIL_RE, isObject, isId, parseDate, parseHHMM,
  parseLocal, weekdayOf, isPositiveInt, isNonNegativeInt, parseQueryInt,
};
