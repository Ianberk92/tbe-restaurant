'use strict';
/**
 * HTTP API for the tracker.
 *
 *   GET    /api/data/{collection}        list documents   (any signed-in user)
 *   GET    /api/data/{collection}/{id}   one document     (any signed-in user)
 *   PUT    /api/data/{writable}/{id}     create/replace
 *   PATCH  /api/data/{writable}/{id}     merge fields
 *   DELETE /api/data/{writable}/{id}     delete
 *
 * Writable collections: reservations, nearby (the restaurant list).
 * Who can write:
 *   - nearby (restaurants): editor role only.
 *   - reservations (bookings): anyone signed in can add one; it is stamped with
 *     createdBy (their sign-in). Changing or deleting a booking needs the editor
 *     role or being its creator. createdBy is set here, never taken from the client.
 * Documents include an `etag`. Send it back as an If-Match header on
 * PUT/DELETE to get 412 instead of overwriting someone else's change.
 *
 * staticwebapp.config.json already limits /api/* to signed-in users and
 * writes to the "editor" role; the checks below repeat that on purpose.
 */
const { app } = require('@azure/functions');
const store = require('../lib/store');
const { getPrincipal, hasRole, who } = require('../lib/auth');
const { READABLE, WRITABLE, ID_RE, CLEANERS } = require('../lib/validate');

const MAX_BODY_BYTES = 32 * 1024;
const CONFLICT = 'Someone else changed this since you opened it. Reload to see their version, then try again.';
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
    const editor = hasRole(principal, 'editor');
    if (!editor && collection !== 'reservations') return json(403, { error: 'Editor role required' });
    if (id === undefined) return json(400, { error: 'An id is required' });
    const me = who(principal).toLowerCase();
    // Editors can change any row; everyone else only bookings they created.
    const mayChange = (doc) => editor || (!!doc && String(doc.createdBy || '').toLowerCase() === me);

    const ifMatch = request.headers.get('if-match') || undefined;
    if (ifMatch && ifMatch.length > 200) return json(400, { error: 'Invalid If-Match header' });
    const clean = CLEANERS[collection];

    if (request.method === 'DELETE') {
      if (!editor) {
        const existing = await store.get(collection, id);
        if (!existing) return { status: 204 };
        if (!mayChange(existing)) return json(403, { error: 'Only the person who added this booking (or an editor) can delete it' });
      }
      await store.remove(collection, id, { etag: ifMatch });
      context.log(`DELETE ${collection}/${id} by ${who(principal)}`);
      return { status: 204 };
    }

    const body = await readBody(request);
    if (body.error) return json(400, { error: body.error });

    if (request.method === 'PUT') {
      const checked = clean(body.value);
      if (checked.error) return json(400, { error: checked.error });
      let value = checked.value;
      if (collection === 'reservations') {
        const existing = await store.get(collection, id);
        if (existing && !mayChange(existing)) return json(403, { error: 'Only the person who added this booking (or an editor) can change it' });
        value = { ...value, createdBy: existing ? existing.createdBy || '' : me };   // keep the original creator
      }
      const saved = await store.put(collection, id, value, who(principal), { etag: ifMatch });
      context.log(`PUT ${collection}/${id} by ${who(principal)}`);
      return json(200, saved);
    }

    if (request.method === 'PATCH') {
      const existing = await store.get(collection, id);
      if (!existing) return json(404, { error: 'Not found' });
      if (!mayChange(existing)) return json(403, { error: 'Only the person who added this booking (or an editor) can change it' });
      const checked = clean(body.value, { partial: true });
      if (checked.error) return json(400, { error: checked.error });
      const { id: _drop, etag: readEtag, ...rest } = existing;
      // Write only if the row is unchanged since this read (or since the caller's If-Match).
      const saved = await store.put(collection, id, { ...rest, ...checked.value }, who(principal), { etag: ifMatch || readEtag });
      context.log(`PATCH ${collection}/${id} by ${who(principal)}`);
      return json(200, saved);
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    // Conditional write lost a race: changed (412) or deleted (404) by someone else.
    if (err.statusCode === 412 || (err.statusCode === 404 && request.method !== 'GET')) {
      return json(412, { error: CONFLICT });
    }
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
