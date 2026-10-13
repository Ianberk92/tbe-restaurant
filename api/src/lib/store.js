'use strict';
/**
 * Azure Table Storage data access.
 *
 * One table (default "dining"). Each document is one entity:
 *   PartitionKey = collection name (reservations | nearby | areas)
 *   RowKey       = document id
 *   json         = the document body as a JSON string (keeps arrays/nested values intact)
 *   updatedBy    = sign-in name of the last writer (audit)
 * Table Storage adds its own Timestamp and ETag. Documents returned here carry
 * that ETag as `etag`; pass it back to put/remove to reject the write if
 * someone else changed the row in the meantime (HTTP 412 from Table Storage).
 */
const { TableClient, odata } = require('@azure/data-tables');

const TABLE_NAME = process.env.TABLE_NAME || 'dining';
let client;
let tableReady;

function getClient() {
  if (!client) {
    const cs = process.env.TABLES_CONNECTION_STRING;
    if (!cs) throw new Error('App setting TABLES_CONNECTION_STRING is not configured');
    const local = /UseDevelopmentStorage=true|127\.0\.0\.1|localhost/i.test(cs);
    client = TableClient.fromConnectionString(cs, TABLE_NAME, { allowInsecureConnection: local });
  }
  return client;
}

async function ensureTable() {
  if (!tableReady) {
    tableReady = getClient().createTable().catch((e) => {
      if (e.statusCode !== 409) { tableReady = null; throw e; }
    });
  }
  return tableReady;
}

function toDoc(entity) {
  let body = {};
  try { body = JSON.parse(entity.json || '{}'); } catch { body = {}; }
  return { id: entity.rowKey, ...body, etag: entity.etag };
}

async function list(collection) {
  await ensureTable();
  const out = [];
  const iter = getClient().listEntities({ queryOptions: { filter: odata`PartitionKey eq ${collection}` } });
  for await (const e of iter) out.push(toDoc(e));
  return out;
}

async function get(collection, id) {
  await ensureTable();
  try {
    return toDoc(await getClient().getEntity(collection, id));
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

/**
 * Creates or replaces a document. With `etag`, only replaces the row if it is
 * unchanged since that ETag was read (throws statusCode 412 or 404 otherwise).
 */
async function put(collection, id, body, user, { etag } = {}) {
  await ensureTable();
  const { id: _ignored, etag: _oldEtag, ...clean } = body || {};
  const entity = { partitionKey: collection, rowKey: id, json: JSON.stringify(clean), updatedBy: user };
  const result = etag
    ? await getClient().updateEntity(entity, 'Replace', { etag })
    : await getClient().upsertEntity(entity, 'Replace');
  return { id, ...clean, etag: result && result.etag };
}

async function remove(collection, id, { etag } = {}) {
  await ensureTable();
  try {
    await getClient().deleteEntity(collection, id, etag ? { etag } : undefined);
  } catch (e) {
    if (e.statusCode !== 404) throw e; // deleting something already gone is fine
  }
}

module.exports = { list, get, put, remove, ensureTable, getClient };
