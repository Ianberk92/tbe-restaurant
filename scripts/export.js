#!/usr/bin/env node
'use strict';
/**
 * Backs up every collection to ./backup-<timestamp>/<collection>.json.
 * Restore by copying a backup file into seed/ and running scripts/seed.js.
 *
 *   TABLES_CONNECTION_STRING="<conn string>" node scripts/export.js
 */
const fs = require('fs');
const path = require('path');
process.env.NODE_PATH = path.join(__dirname, '..', 'api', 'node_modules');
require('module').Module._initPaths();
const store = require('../api/src/lib/store');

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(process.cwd(), `backup-${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  for (const collection of ['reservations', 'nearby', 'areas']) {
    const docs = await store.list(collection);
    fs.writeFileSync(path.join(out, `${collection}.json`), JSON.stringify(docs, null, 2));
    console.log(`Saved ${docs.length} ${collection}`);
  }
  console.log(`Backup written to ${out}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
