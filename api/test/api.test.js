'use strict';
// Unit tests for the HTTP handler with an in-memory store (no Azure needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// In-memory replacement for ../src/lib/store, with Table Storage-style ETags
const mem = new Map();   // key -> document body
const tags = new Map();  // key -> current etag
let version = 0;
const conflict = (code) => Object.assign(new Error('precondition'), { statusCode: code });
const fakeStore = {
  async list(c) { return [...mem.entries()].filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => ({ id: k.split('/')[1], ...v, etag: tags.get(k) })); },
  async get(c, id) { const k = `${c}/${id}`; const v = mem.get(k); return v ? { id, ...v, etag: tags.get(k) } : null; },
  async put(c, id, body, _user, { etag } = {}) {
    const k = `${c}/${id}`;
    if (etag && !mem.has(k)) throw conflict(404);
    if (etag && tags.get(k) !== etag) throw conflict(412);
    const { id: _x, etag: _e, ...rest } = body;
    mem.set(k, rest); tags.set(k, `W/"${++version}"`);
    return { id, ...rest, etag: tags.get(k) };
  },
  async remove(c, id, { etag } = {}) {
    const k = `${c}/${id}`;
    if (etag && mem.has(k) && tags.get(k) !== etag) throw conflict(412);
    mem.delete(k); tags.delete(k);
  },
};
require.cache[path.resolve(__dirname, '../src/lib/store.js')] = { exports: fakeStore, loaded: true, id: 'store' };
// Stub @azure/functions registration so the module can load without the host.
require.cache[require.resolve('@azure/functions')] = { exports: { app: { http() {} } }, loaded: true, id: 'af' };
const { handler } = require('../src/functions/data');

const principal = (roles) => Buffer.from(JSON.stringify({ userDetails: 'lramos@example.com', userRoles: ['anonymous', 'authenticated', ...roles] })).toString('base64');
function req(method, params, { roles = null, body, ifMatch } = {}) {
  const headers = new Map();
  if (roles) headers.set('x-ms-client-principal', principal(roles));
  if (ifMatch) headers.set('if-match', ifMatch);
  return { method, params, headers: { get: (k) => headers.get(k) ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
}
const ctx = { log() {}, error() {} };

test('rejects anonymous callers', async () => {
  const r = await handler(req('GET', { collection: 'nearby' }), ctx);
  assert.equal(r.status, 401);
});

test('signed-in viewer can list reference data', async () => {
  mem.set('nearby/zios', { name: "Zio's" });
  const r = await handler(req('GET', { collection: 'nearby' }, { roles: [] }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody[0].name, "Zio's");
});

test('viewer cannot write', async () => {
  const r = await handler(req('PUT', { collection: 'reservations', id: 'r1' }, { roles: [], body: { restaurant: 'Edge' } }), ctx);
  assert.equal(r.status, 403);
});

test('areas are read-only even for editors', async () => {
  const r = await handler(req('PUT', { collection: 'areas', id: 'x' }, { roles: ['editor'], body: { name: 'x' } }), ctx);
  assert.equal(r.status, 405);
});

test('viewer cannot add a restaurant', async () => {
  const r = await handler(req('PUT', { collection: 'nearby', id: 'n1' }, { roles: [], body: { name: 'Test' } }), ctx);
  assert.equal(r.status, 403);
});

test('editor adds and edits a restaurant', async () => {
  let r = await handler(req('PUT', { collection: 'nearby', id: 'n1' }, { roles: ['editor'], body: {
    name: 'Lotus of Siam', area: 'paradise', booking: 'Reservable', fit: ['Dinner', 'Dinner'], total: '18',
    bookUrl: 'https://www.opentable.com/x', junk: 'dropped' } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.total, 18);
  assert.deepEqual(r.jsonBody.fit, ['Dinner']);
  assert.equal(r.jsonBody.junk, undefined);

  r = await handler(req('PATCH', { collection: 'nearby', id: 'n1' }, { roles: ['editor'], body: { watch: 'Cash only' } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.watch, 'Cash only');
  assert.equal(r.jsonBody.name, 'Lotus of Siam');
});

test('restaurant validation catches bad input', async () => {
  const bad = [
    { name: '', fit: ['Dinner'] },
    { name: 'x', fit: ['Dinner'], booking: 'Maybe' },
    { name: 'x', fit: ['Brunch'] },
    { name: 'x', fit: 'Dinner' },
    { name: 'x', fit: [] },
    { name: 'x' },
    { name: 'x', fit: ['Dinner'], bookUrl: 'javascript:alert(1)' },
    { name: 'x', fit: ['Dinner'], total: -5 },
  ];
  for (const body of bad) {
    const r = await handler(req('PUT', { collection: 'nearby', id: 'n2' }, { roles: ['editor'], body }), ctx);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('stale If-Match is rejected instead of overwriting another edit', async () => {
  let r = await handler(req('PUT', { collection: 'reservations', id: 'r3' }, { roles: ['editor'], body: { restaurant: 'Edge' } }), ctx);
  const first = r.jsonBody.etag;
  // Another editor saves in between.
  r = await handler(req('PUT', { collection: 'reservations', id: 'r3' }, { roles: ['editor'], body: { restaurant: 'Edge', party: 6 }, ifMatch: first }), ctx);
  assert.equal(r.status, 200);
  // The first editor's save, based on the old version, is refused.
  r = await handler(req('PUT', { collection: 'reservations', id: 'r3' }, { roles: ['editor'], body: { restaurant: 'Edge', party: 2 }, ifMatch: first }), ctx);
  assert.equal(r.status, 412);
  assert.equal(mem.get('reservations/r3').party, 6);
  r = await handler(req('DELETE', { collection: 'reservations', id: 'r3' }, { roles: ['editor'], ifMatch: first }), ctx);
  assert.equal(r.status, 412);
  assert.equal(mem.has('reservations/r3'), true);
});

test('editor creates, patches and deletes a reservation', async () => {
  let r = await handler(req('PUT', { collection: 'reservations', id: 'r1' }, { roles: ['editor'], body: { restaurant: 'Edge Steakhouse', status: 'Hold', party: '4', junk: 'dropped' } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.party, 4);
  assert.equal(r.jsonBody.junk, undefined);

  r = await handler(req('PATCH', { collection: 'reservations', id: 'r1' }, { roles: ['editor'], body: { status: 'Confirmed' } }), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.status, 'Confirmed');
  assert.equal(r.jsonBody.restaurant, 'Edge Steakhouse');

  r = await handler(req('DELETE', { collection: 'reservations', id: 'r1' }, { roles: ['editor'] }), ctx);
  assert.equal(r.status, 204);
  assert.equal(mem.has('reservations/r1'), false);
});

test('validation catches bad input', async () => {
  const bad = [
    [{ status: 'Maybe', restaurant: 'x' }, 400],
    [{ restaurant: '' }, 400],
    [{ restaurant: 'x', map: 'javascript:alert(1)' }, 400],
    [{ restaurant: 'x'.repeat(300) }, 400],
  ];
  for (const [body, code] of bad) {
    const r = await handler(req('PUT', { collection: 'reservations', id: 'r2' }, { roles: ['editor'], body }), ctx);
    assert.equal(r.status, code, JSON.stringify(body));
  }
  const r = await handler(req('GET', { collection: 'reservations', id: '../etc' }, { roles: [] }), ctx);
  assert.equal(r.status, 400);
});

test('config returns the Maps embed key only to signed-in users, and only if well-formed', async () => {
  const { handler: config } = require('../src/functions/config');
  process.env.GOOGLE_MAPS_EMBED_KEY = 'AIzaSyTestKey_0123456789abcdefghij';
  assert.equal((await config(req('GET', {}))).status, 401);
  let r = await config(req('GET', {}, { roles: [] }));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.mapsEmbedKey, 'AIzaSyTestKey_0123456789abcdefghij');
  process.env.GOOGLE_MAPS_EMBED_KEY = 'not a key"><script>';
  r = await config(req('GET', {}, { roles: [] }));
  assert.equal(r.jsonBody.mapsEmbedKey, '');
  delete process.env.GOOGLE_MAPS_EMBED_KEY;
  r = await config(req('GET', {}, { roles: [] }));
  assert.equal(r.jsonBody.mapsEmbedKey, '');
});
