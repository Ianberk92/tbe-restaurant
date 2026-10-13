'use strict';
/**
 * HTTP API for the tracker.
 *
 *   GET    /api/data/{collection}        list documents   (any signed-in user)
 *   GET    /api/data/{collection}/{id}   one document     (any signed-in user)
 *   PUT    /api/data/reservations/{id}   create/replace   (editor role)
 *   PATCH  /api/data/reservations/{id}   merge fields     (editor role)
 *   DELETE /api/data/reservations/{id}   delete           (editor role)
 *
 * staticwebapp.config.json already limits /api/* to signed-in users and
 * writes to the "editor" role; the checks below repeat that on purpose.
 */
const { app } = require('@azure/functions');
const store = require('../lib/store');
const { getPrincipal, hasRole, who } = require('../lib/auth');
const { READABLE, WRITABLE, ID_RE, cleanReservation } = require('../lib/validate');

const MAX_BODY_BYTES = 32 * 1024;
const json = (status, body) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });

async function readBody(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { error: 'Body too large' };
  try { return { value: JSON.parse(text || '{}') }; } catch { return { error: 'Body must be valid JSON' }; }
}

async function handler(request, context) {
  const principal = getPrincipal(request);
  if (!principal) return json(401, { error: 'Sign in required' });

  const { collection, id } = request.params;
  if (!READABLE.has(collection)) return json(404, { error: 'Unknown collection' });
  if (id !== undefined && !ID_RE.test(id)) return json(400, { error: 'Invalid id' });

  try {
    if (request.method === 'GET') {
      if (id === undefined) return json(200, await store.list(collection));
      const doc = await store.get(collection, id);
      return doc ? json(200, doc) : json(404, { error: 'Not found' });
    }

    // Everything below is a write.
    if (!WRITABLE.has(collection)) return json(405, { error: 'This collection is read-only' });
    if (!hasRole(principal, 'editor')) return json(403, { error: 'Editor role required' });
    if (id === undefined) return json(400, { error: 'An id is required' });

    if (request.method === 'DELETE') {
      await store.remove(collection, id);
      context.log(`DELETE ${collection}/${id} by ${who(principal)}`);
      return { status: 204 };
    }

    const body = await readBody(request);
    if (body.error) return json(400, { error: body.error });

    if (request.method === 'PUT') {
      const clean = cleanReservation(body.value);
      if (clean.error) return json(400, { error: clean.error });
      const saved = await store.put(collection, id, clean.value, who(principal));
      context.log(`PUT ${collection}/${id} by ${who(principal)}`);
      return json(200, saved);
    }

    if (request.method === 'PATCH') {
      const existing = await store.get(collection, id);
      if (!existing) return json(404, { error: 'Not found' });
      const clean = cleanReservation(body.value, { partial: true });
      if (clean.error) return json(400, { error: clean.error });
      const { id: _drop, ...rest } = existing;
      const saved = await store.put(collection, id, { ...rest, ...clean.value }, who(principal));
      context.log(`PATCH ${collection}/${id} by ${who(principal)}`);
      return json(200, saved);
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    context.error(`API error on ${request.method} ${collection}/${id || ''}: ${err.message}`);
    return json(500, { error: 'Server error. Try again shortly.' });
  }
}

app.http('data', {
  methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
  authLevel: 'anonymous', // auth is enforced by Static Web Apps + the role checks above
  route: 'data/{collection}/{id?}',
  handler,
});

module.exports = { handler }; // exported for local tests
