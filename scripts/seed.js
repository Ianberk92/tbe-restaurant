#!/usr/bin/env node
'use strict';
/**
 * Loads the reference data (areas + nearby restaurants) into Table Storage.
 * Safe to re-run: by default it only adds documents that aren't in the table
 * yet, so restaurants edited in the app are left alone. It never touches
 * reservations unless seed/reservations.json exists.
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

const overwrite = process.argv.includes('--overwrite');

async function main() {
  const dir = path.join(__dirname, '..', 'seed');
  for (const collection of ['areas', 'nearby', 'reservations']) {
    const file = path.join(dir, `${collection}.json`);
    if (!fs.existsSync(file)) continue;
    const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const existing = overwrite ? new Set() : new Set((await store.list(collection)).map((d) => d.id));
    let loaded = 0;
    for (const doc of docs) {
      if (!doc.id) throw new Error(`Missing id in ${collection}.json`);
      if (existing.has(doc.id)) continue;
      await store.put(collection, doc.id, doc, 'seed-script');
      loaded++;
    }
    const skipped = docs.length - loaded;
    console.log(`Loaded ${loaded} ${collection}` + (skipped ? ` (skipped ${skipped} already in the table; use --overwrite to replace)` : ''));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
