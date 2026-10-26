'use strict';
/**
 * Loads restaurant/area updates shipped in seed/*.json into the live table,
 * so an editor can apply them from the app (no Azure access needed).
 *
 *   GET  /api/updates   → { pending, areas, edits, names }   (editors; others always get pending 0)
 *   POST /api/updates   → { added, places, edited }    (editor role; places = restaurants among added)
 *
 * Insert-only: rows already in the table are never changed, and a place
 * removed in the app is not offered again (rules in lib/seedsync.js).
 *
 * The deploy workflow copies seed/ into api/seed; locally the repo's seed/
 * is used.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('@azure/functions');
const store = require('../lib/store');
const { getPrincipal, hasRole, who } = require('../lib/auth');
const { pending, applyPatches, remember } = require('../lib/seedsync');

const json = (status, body) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });

function seedDir() {
  const dirs = [process.env.SEED_DIR, path.join(__dirname, '../../seed'), path.join(__dirname, '../../../seed')].filter(Boolean);   // SEED_DIR: tests
  return dirs.find((d) => fs.existsSync(path.join(d, 'nearby.json')));
}

async function handler(request, context) {
  const principal = getPrincipal(request);
  if (!principal) return json(401, { error: 'Sign in required' });
  const editor = hasRole(principal, 'editor');
  try {
    if (request.method === 'GET') {
      // editor and seedFiles make this endpoint a one-glance check when the button doesn't appear
      if (!editor) return json(200, { editor: false, pending: 0, names: [], note: 'Only editors can load updates.' });
      const dir = seedDir();
      const { todo, patches } = await pending(store, dir);
      const names = todo.filter((s) => s.collection === 'nearby').map((s) => s.body.name);
      return json(200, { editor: true, seedFiles: !!dir, pending: names.length, areas: todo.length - names.length, edits: patches.length, names: names.slice(0, 8) });
    }
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!editor) return json(403, { error: 'Editor role required' });

    const { seed, meta, todo, patches, patchKeys } = await pending(store, seedDir());
    let added = 0, places = 0;
    for (const s of todo) {
      if (await store.insert(s.collection, s.id, s.body, who(principal))) { added++; if (s.collection === 'nearby') places++; }
    }
    const edited = await applyPatches(store, patches, who(principal));
    await remember(store, meta, seed, who(principal), patchKeys);   // so removed places stay removed, edits apply once
    context.log(`POST updates: added ${added}, edited ${edited} by ${who(principal)}`);
    return json(200, { added, places, edited });
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
