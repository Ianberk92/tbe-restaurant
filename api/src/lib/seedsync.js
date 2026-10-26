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
 *
 * seed/patches.json holds field edits to rows that are already live, grouped
 * by update name: { "<update>": { "<collection>": { "<id>": { field: value } } } }.
 * Each one is applied once (tracked in meta/seed) and only if the row exists;
 * the other fields on the row are kept.
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
  // Field edits to live rows not applied yet (rows inserted by this run already carry the new values)
  const applied = new Set((meta && meta.patched) || []);
  const patches = [], patchKeys = [];
  for (const [name, cols] of Object.entries(readJson(path.join(dir || '', 'patches.json')) || {})) {
    if (name.startsWith('_') || !cols || typeof cols !== 'object') continue;
    for (const collection of COLLECTIONS) {
      for (const [id, fields] of Object.entries(cols[collection] || {})) {
        const key = `${name}:${collection}/${id}`;
        patchKeys.push(key);   // all of them get marked done after a run (rows inserted now already carry the values)
        if (!ID_RE.test(id) || applied.has(key) || !have.has(`${collection}/${id}`)) continue;
        if (collection === 'nearby') {
          const checked = cleanNearby(fields, { partial: true });
          if (checked.error) continue;
          patches.push({ key, collection, id, fields: checked.value });
        } else {
          patches.push({ key, collection, id, fields });
        }
      }
    }
  }
  return { seed, meta, todo, patches, patchKeys };
}

/** Merge each patch into its live row; returns how many rows changed. */
async function applyPatches(store, patches, user) {
  let n = 0;
  for (const p of patches) {
    const row = await store.get(p.collection, p.id);
    if (!row) continue;   // removed since; nothing to patch
    const { id: _id, etag, ...rest } = row;
    await store.put(p.collection, p.id, { ...rest, ...p.fields }, user, { etag });
    n++;
  }
  return n;
}

/** Remember every seed id as offered (call after loading). */
async function remember(store, meta, seed, user, patchKeys = []) {
  const ids = [...new Set([...((meta && meta.ids) || []), ...seed.map((s) => `${s.collection}/${s.id}`)])];
  const patched = [...new Set([...((meta && meta.patched) || []), ...patchKeys])];
  await store.put(...META, { ids, patched, updatedAt: new Date().toISOString() }, user);
}

module.exports = { COLLECTIONS, readSeed, pending, applyPatches, remember };
