'use strict';
/** Input rules for writes. Reservations and the restaurant list are writable from the app (editor role). */

const READABLE = new Set(['reservations', 'nearby', 'areas']);
const WRITABLE = new Set(['reservations', 'nearby']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Every field the reservation form can send, with a max length for strings.
const RESERVATION_FIELDS = {
  area: 40, date: 10, time: 5, meal: 20, status: 20, restaurant: 200, location: 200,
  map: 500, travel: null, host: 120, party: null, company: 200, purpose: 40,
  attendees: 1000, conf: 100, bookedUnder: 200, platform: 60, cancelBy: 16,
  fee: 120, deposit: 200, notes: 2000, updatedAt: 40,
};
const STATUSES = new Set(['Hold', 'Confirmed', 'Released', 'Cancelled']);

// Every field a restaurant ("nearby") document can hold. Numbers are minutes, except distMi.
const NEARBY_FIELDS = {
  name: 120, area: 40, booking: 20, bookingNote: 400, fit: 'list', hotel: 120, hours: 300,
  meals: 200, phone: 60, route: 400, venue: 120, walkLabel: 40, watch: 400, mapUrl: 500,
  bookUrl: 500, exitMin: null, walkMin: null, insideMin: null, total: null, totalBusy: null,
  distMi: null, updatedAt: 40,
};
const BOOKING_TYPES = new Set(['Reservable', 'Walk-in', 'Unconfirmed', 'Grab-and-go']);
const MEALS = new Set(['Breakfast', 'Lunch', 'Dinner', 'Drinks']);

/** Copies allowed fields from input, checking types and lengths. */
function pickFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Body must be a JSON object' };
  }
  const out = {};
  for (const [key, max] of Object.entries(fields)) {
    if (!(key in input)) continue;
    let v = input[key];
    if (max === 'list') {
      // list of meal names
      if (!Array.isArray(v) || !v.every((m) => MEALS.has(m))) return { error: `${key} must be a list of Breakfast, Lunch, Dinner, Drinks` };
      out[key] = [...new Set(v)];
    } else if (max === null) {
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
  return { value: out };
}

function cleanReservation(input, { partial = false } = {}) {
  const picked = pickFields(input, RESERVATION_FIELDS);
  if (picked.error) return picked;
  const out = picked.value;
  if (out.status !== undefined && out.status !== '' && !STATUSES.has(out.status)) {
    return { error: 'status must be Hold, Confirmed, Released or Cancelled' };
  }
  if (!partial && !out.restaurant) return { error: 'restaurant is required' };
  if (out.map && !/^https?:\/\//i.test(out.map)) return { error: 'map must be an http(s) link' };
  return { value: out };
}

function cleanNearby(input, { partial = false } = {}) {
  const picked = pickFields(input, NEARBY_FIELDS);
  if (picked.error) return picked;
  const out = picked.value;
  if (!partial && !out.name) return { error: 'name is required' };
  // Without at least one meal the restaurant wouldn't appear in any view.
  if ((!partial || out.fit !== undefined) && !(out.fit && out.fit.length)) return { error: 'fit must list at least one meal' };
  if (out.booking !== undefined && out.booking !== '' && !BOOKING_TYPES.has(out.booking)) {
    return { error: 'booking must be Reservable, Walk-in, Unconfirmed or Grab-and-go' };
  }
  for (const k of ['mapUrl', 'bookUrl']) {
    if (out[k] && !/^https?:\/\//i.test(out[k])) return { error: `${k} must be an http(s) link` };
  }
  return { value: out };
}

/** Validator for each writable collection. */
const CLEANERS = { reservations: cleanReservation, nearby: cleanNearby };

module.exports = { READABLE, WRITABLE, ID_RE, cleanReservation, cleanNearby, CLEANERS };
