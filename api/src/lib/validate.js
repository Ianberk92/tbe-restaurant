'use strict';
/** Input rules for writes. Only the reservations collection is writable from the app. */

const READABLE = new Set(['reservations', 'nearby', 'areas']);
const WRITABLE = new Set(['reservations']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Every field the reservation form can send, with a max length for strings.
const RESERVATION_FIELDS = {
  area: 40, date: 10, time: 5, meal: 20, status: 20, restaurant: 200, location: 200,
  map: 500, travel: null, host: 120, party: null, company: 200, purpose: 40,
  attendees: 1000, conf: 100, bookedUnder: 200, platform: 60, cancelBy: 16,
  fee: 120, deposit: 200, notes: 2000, updatedAt: 40,
};
const STATUSES = new Set(['Hold', 'Confirmed', 'Released', 'Cancelled']);

function cleanReservation(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Body must be a JSON object' };
  }
  const out = {};
  for (const [key, max] of Object.entries(RESERVATION_FIELDS)) {
    if (!(key in input)) continue;
    let v = input[key];
    if (max === null) {
      // numeric fields: allow empty string or a non-negative number
      if (v === '' || v === null) { out[key] = ''; continue; }
      v = Number(v);
      if (!Number.isFinite(v) || v < 0 || v > 10000) return { error: `${key} must be a number` };
      out[key] = v;
    } else {
      if (v === null || v === undefined) v = '';
      if (typeof v !== 'string') return { error: `${key} must be text` };
      if (v.length > max) return { error: `${key} is too long (max ${max})` };
      out[key] = v;
    }
  }
  if (out.status !== undefined && out.status !== '' && !STATUSES.has(out.status)) {
    return { error: 'status must be Hold, Confirmed, Released or Cancelled' };
  }
  if (!partial && !out.restaurant) return { error: 'restaurant is required' };
  if (out.map && !/^https?:\/\//i.test(out.map)) return { error: 'map must be an http(s) link' };
  return { value: out };
}

module.exports = { READABLE, WRITABLE, ID_RE, cleanReservation };
