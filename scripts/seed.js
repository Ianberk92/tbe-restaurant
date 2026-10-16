#!/usr/bin/env node
'use strict';
/**
 * Loads the reference data (areas + nearby restaurants) into Table Storage.
 * Safe to re-run: by default it only adds documents that aren't in the table
 * yet, so restaurants edited in the app are left alone, and places removed in
 * the app are not brought back (same rules as the in-app button; see
 * api/src/lib/seedsync.js). It never touches reservations unless
 * seed/reservations.json exists.
 *
 *   cd api && npm ci && cd ..
 *   TABLES_CONNECTION_STRING="<conn string>" node scripts/seed.js
 *
 * Add --overwrite to replace existing documents with the seed files
 * (use this to restore from a backup).
 */
const fs = require('fs');
const path = require('path');
process.env.NODE_PATH = path.join(__dirname, '..', 'api', 'node_modules');
require('module').Module._initPaths();
const store = require('../api/src/lib/store');
const { COLLECTIONS, pending, remember } = require('../api/src/lib/seedsync');

const overwrite = process.argv.includes('--overwrite');

async function main() {
  const dir = path.join(__dirname, '..', 'seed');
  if (overwrite) {
    // Restore: write every seed document as-is.
    for (const collection of [...COLLECTIONS, 'reservations']) {
      const file = path.join(dir, `${collection}.json`);
      if (!fs.existsSync(file)) continue;
      const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const doc of docs) {
        if (!doc.id) throw new Error(`Missing id in ${collection}.json`);
        await store.put(collection, doc.id, doc, 'seed-script');
      }
      console.log(`Loaded ${docs.length} ${collection} (overwrite)`);
    }
    return;
  }
  const { seed, meta, todo } = await pending(store, dir);
  for (const collection of COLLECTIONS) {
    const mine = todo.filter((s) => s.collection === collection);
    let loaded = 0;
    for (const s of mine) if (await store.insert(collection, s.id, s.body, 'seed-script')) loaded++;
    const skipped = seed.filter((s) => s.collection === collection).length - loaded;
    console.log(`Loaded ${loaded} ${collection}` + (skipped ? ` (skipped ${skipped}: already in the table or removed in the app; use --overwrite to restore)` : ''));
  }
  await remember(store, meta, seed, 'seed-script');
  // Reservations are only loaded from a backup file, and never over existing ones.
  const resFile = path.join(dir, 'reservations.json');
  if (fs.existsSync(resFile)) {
    let loaded = 0;
    for (const doc of JSON.parse(fs.readFileSync(resFile, 'utf8'))) {
      if (!doc.id) throw new Error('Missing id in reservations.json');
      const { id, ...body } = doc;
      if (await store.insert('reservations', id, body, 'seed-script')) loaded++;
    }
    console.log(`Loaded ${loaded} reservations`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
