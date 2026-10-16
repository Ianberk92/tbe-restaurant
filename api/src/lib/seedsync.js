'use strict';
/**
 * Shared rules for loading seed/*.json into the live table, used by both the
 * in-app "new places ready" button (functions/updates.js) and scripts/seed.js.
 *
 * Insert-only, and a place is offered once: every id loaded or offered is
 * remembered in meta/seed, so something removed in the app doesn't come back.
 * Ids in seed/baseline.json (everything shipped before tracking began) count
 * as offered whenever the table already has rows of that collection, so a
 * fresh table still gets the full list while an existing one never gets back
 * places deleted earlier.
 */
const fs = require('fs');
const path = require('path');
const { ID_RE, cleanNearby } = require('./validate');

const COLLECTIONS = ['areas', 'nearby'];   // areas first so new places have a home
const META = ['meta', 'seed'];

function readJson(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }

/** Valid seed rows from a seed directory: [{collection, id, body}] */
function readSeed(dir) {
  const out = [];
  if (!dir) return out;
  for (const collection of COLLECTIONS) {
    for (const doc of readJson(path.join(dir, `${collection}.json`)) || []) {
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
async function pending(store, dir) {
  const seed = readSeed(dir);
  const meta = await store.get(...META);
  const offered = new Set((meta && meta.ids) || []);
  const baseline = ((readJson(path.join(dir || '', 'baseline.json')) || {}).ids) || [];
  const have = new Set();
  for (const c of COLLECTIONS) {
    const rows = await store.list(c);
    for (const d of rows) have.add(`${c}/${d.id}`);
    if (rows.length) for (const k of baseline) if (k.startsWith(c + '/')) offered.add(k);
  }
  const todo = seed.filter((s) => !have.has(`${s.collection}/${s.id}`) && !offered.has(`${s.collection}/${s.id}`));
  return { seed, meta, todo };
}

/** Remember every seed id as offered (call after loading). */
async function remember(store, meta, seed, user) {
  const ids = [...new Set([...((meta && meta.ids) || []), ...seed.map((s) => `${s.collection}/${s.id}`)])];
  await store.put(...META, { ids, updatedAt: new Date().toISOString() }, user);
}

module.exports = { COLLECTIONS, readSeed, pending, remember };
