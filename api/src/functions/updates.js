'use strict';
/**
 * Loads restaurant/area updates shipped in seed/*.json into the live table,
 * so an editor can apply them from the app (no Azure access needed).
 *
 *   GET  /api/updates   → { pending, names }   (editors; others always get pending 0)
 *   POST /api/updates   → { added, places }    (editor role; places = restaurants among added)
 *
 * Insert-only: rows already in the table are never changed. Every id that
 * has been offered is remembered in meta/seed, so a place someone removed
 * in the app doesn't come back on the next update.
 *
 * The deploy workflow copies seed/ into api/seed; locally the repo's seed/
 * is used.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('@azure/functions');
const store = require('../lib/store');
const { getPrincipal, hasRole, who } = require('../lib/auth');
const { ID_RE, cleanNearby } = require('../lib/validate');

const COLLECTIONS = ['areas', 'nearby'];   // areas first so new places have a home
const META = ['meta', 'seed'];
const json = (status, body) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });

function seedDir() {
  const dirs = [path.join(__dirname, '../../seed'), path.join(__dirname, '../../../seed')];
  return dirs.find((d) => fs.existsSync(path.join(d, 'nearby.json')));
}

function readSeed() {
  const dir = seedDir();
  if (!dir) return [];
  const out = [];
  for (const collection of COLLECTIONS) {
    const file = path.join(dir, `${collection}.json`);
    if (!fs.existsSync(file)) continue;
    for (const doc of JSON.parse(fs.readFileSync(file, 'utf8'))) {
      if (!doc || !ID_RE.test(doc.id || '')) continue;
      const { id, ...body } = doc;
      if (collection === 'nearby') {
        const checked = cleanNearby(body);
        if (checked.error) continue;   // a bad seed row is skipped, not loaded half-valid
        out.push({ collection, id, body: checked.value });
      } else {
        out.push({ collection, id, body });
      }
    }
  }
  return out;
}

/** Seed rows that are neither in the table nor offered before. */
async function pending() {
  const seed = readSeed();
  const meta = await store.get(...META);
  const offered = new Set((meta && meta.ids) || []);
  const have = new Set();
  for (const c of COLLECTIONS) for (const d of await store.list(c)) have.add(`${c}/${d.id}`);
  return { seed, meta, todo: seed.filter((s) => !have.has(`${s.collection}/${s.id}`) && !offered.has(`${s.collection}/${s.id}`)) };
}

async function handler(request, context) {
  const principal = getPrincipal(request);
  if (!principal) return json(401, { error: 'Sign in required' });
  const editor = hasRole(principal, 'editor');
  try {
    if (request.method === 'GET') {
      if (!editor) return json(200, { pending: 0, names: [] });
      const { todo } = await pending();
      const names = todo.filter((s) => s.collection === 'nearby').map((s) => s.body.name);
      return json(200, { pending: names.length, areas: todo.length - names.length, names: names.slice(0, 8) });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!editor) return json(403, { error: 'Editor role required' });

    const { seed, meta, todo } = await pending();
    let added = 0, places = 0;
    for (const s of todo) {
      if (await store.insert(s.collection, s.id, s.body, who(principal))) { added++; if (s.collection === 'nearby') places++; }
    }
    // Remember everything offered so far, so removed places stay removed.
    const ids = [...new Set([...((meta && meta.ids) || []), ...seed.map((s) => `${s.collection}/${s.id}`)])];
    await store.put(...META, { ids, updatedAt: new Date().toISOString() }, who(principal));
    context.log(`POST updates: added ${added} by ${who(principal)}`);
    return json(200, { added, places });
  } catch (err) {
    context.error(`API error on ${request.method} updates: ${err.message}`);
    return json(500, { error: 'Server error. Try again shortly.' });
  }
}

app.http('updates', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous', // auth is enforced by Static Web Apps + the role check above
  route: 'updates',
  handler,
});

module.exports = { handler }; // exported for local tests
