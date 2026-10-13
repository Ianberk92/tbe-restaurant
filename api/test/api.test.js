'use strict';
// Unit tests for the HTTP handler with an in-memory store (no Azure needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// In-memory replacement for ../src/lib/store
const mem = new Map();
const fakeStore = {
  async list(c) { return [...mem.entries()].filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => ({ id: k.split('/')[1], ...v })); },
  async get(c, id) { const v = mem.get(`${c}/${id}`); return v ? { id, ...v } : null; },
  async put(c, id, body) { const { id: _x, ...rest } = body; mem.set(`${c}/${id}`, rest); return { id, ...rest }; },
  async remove(c, id) { mem.delete(`${c}/${id}`); },
};
require.cache[path.resolve(__dirname, '../src/lib/store.js')] = { exports: fakeStore, loaded: true, id: 'store' };
// Stub @azure/functions registration so the module can load without the host.
require.cache[require.resolve('@azure/functions')] = { exports: { app: { http() {} } }, loaded: true, id: 'af' };
const { handler } = require('../src/functions/data');

const principal = (roles) => Buffer.from(JSON.stringify({ userDetails: 'lramos@example.com', userRoles: ['anonymous', 'authenticated', ...roles] })).toString('base64');
function req(method, params, { roles = null, body } = {}) {
  const headers = new Map();
  if (roles) headers.set('x-ms-client-principal', principal(roles));
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

test('reference collections are read-only even for editors', async () => {
  const r = await handler(req('PUT', { collection: 'nearby', id: 'x' }, { roles: ['editor'], body: { name: 'x' } }), ctx);
  assert.equal(r.status, 405);
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
