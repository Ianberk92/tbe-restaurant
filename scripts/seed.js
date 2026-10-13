#!/usr/bin/env node
'use strict';
/**
 * Loads the reference data (areas + nearby restaurants) into Table Storage.
 * Safe to re-run: it upserts by id and never touches reservations unless
 * seed/reservations.json exists.
 *
 *   cd api && npm ci && cd ..
 *   TABLES_CONNECTION_STRING="<conn string>" node scripts/seed.js
 */
const fs = require('fs');
const path = require('path');
process.env.NODE_PATH = path.join(__dirname, '..', 'api', 'node_modules');
require('module').Module._initPaths();
const store = require('../api/src/lib/store');

async function main() {
  const dir = path.join(__dirname, '..', 'seed');
  for (const collection of ['areas', 'nearby', 'reservations']) {
    const file = path.join(dir, `${collection}.json`);
    if (!fs.existsSync(file)) continue;
    const docs = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const doc of docs) {
      if (!doc.id) throw new Error(`Missing id in ${collection}.json`);
      await store.put(collection, doc.id, doc, 'seed-script');
    }
    console.log(`Loaded ${docs.length} ${collection}`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
