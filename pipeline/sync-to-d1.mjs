// Phase 3 — replicate the canonical SQLite content tables into Cloudflare D1.
//
// MODEL: SQLite (the release-asset DB) stays the source of truth and the build
// keeps reading it. D1 is a read-replica for runtime SSR (Phase 4 Tier-2 pages).
// Ingestion is UNCHANGED — this runs as a separate step after the DB is
// published, so a sync failure can never corrupt ingest state. Generalises the
// proven sync-widgets-to-d1.mjs (same D1 REST API + batched INSERT OR REPLACE).
//
// Tables are introspected via PRAGMA table_info so column drift doesn't break
// the sync. Per table you can give an incremental column (e.g. enriched_at) so
// routine runs only push changed rows; `--full` forces a complete re-upsert.
//
// Requires env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID.
// The TABLES schema must already exist in D1 (apply pipeline/schema.sql first —
// see D1_MIGRATION_RUNBOOK.md). This script only moves DATA, never DDL.
//
// Usage:
//   node --env-file=../.env sync-to-d1.mjs            # incremental
//   node --env-file=../.env sync-to-d1.mjs --full     # full re-upsert
//   node --env-file=../.env sync-to-d1.mjs --tables filings_enriched,briefings

import { openDb, withHealth } from './db.mjs';

// D1 caps bound parameters per query (~100). batchSize = floor(CAP / ncols).
const PARAM_CAP = 90;

// Read surface SSR needs. `incremental` is a monotonic column used to push only
// new/changed rows on routine runs; omit for small tables that are cheap to
// re-upsert wholesale.
// Names match the live DB (verified). A wrong/absent incremental column safely
// degrades to a full re-upsert (see syncTable), and a table missing locally is
// skipped — so this list is forgiving.
const TABLES = [
  { name: 'filings_raw',          incremental: 'created_on' },
  { name: 'filings_enriched',     incremental: 'enriched_at' },
  { name: 'briefings',            incremental: null },
  { name: 'concalls_raw',         incremental: null },
  { name: 'concalls_enriched',    incremental: 'enriched_at' },
  { name: 'alphastreet_raw',      incremental: null },
  { name: 'alphastreet_enriched', incremental: 'enriched_at' },
  { name: 'circulars_raw',        incremental: null },
  { name: 'circulars_enriched',   incremental: 'enriched_at' },
  { name: 'rbi_raw',              incremental: null },
  { name: 'rbi_enriched',         incremental: 'enriched_at' },
  { name: 'macro_calendar',       incremental: null },
  { name: 'macro_enriched',       incremental: 'enriched_at' },
  { name: 'fundamentals',         incremental: null },
  { name: 'market_signals',       incremental: null },
  { name: 'market_history',       incremental: null },
  { name: 'market_snapshots',     incremental: null },
  { name: 'radar_items',          incremental: null },
  { name: 'company_snapshots',    incremental: null },
  { name: 'source_health',        incremental: null },
];

function parseArgs(argv) {
  const full = argv.includes('--full');
  const dry = argv.includes('--dry-run');
  const tIdx = argv.indexOf('--tables');
  const only = tIdx >= 0 && argv[tIdx + 1] ? new Set(argv[tIdx + 1].split(',').map(s => s.trim())) : null;
  return { full, dry, only };
}

async function d1Query(env, sql, params = []) {
  if (env.dry) return { dry: true }; // --dry-run: validate locally, no network/creds needed
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/d1/database/${env.dbId}/query`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`D1 API ${r.status}: ${text.slice(0, 300)}`);
  }
  return r.json();
}

function tableExistsLocally(sqlite, name) {
  return !!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnsOf(sqlite, name) {
  return sqlite.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
}

// Persisted per-table watermark so incremental runs are cheap.
function ensureSyncState(sqlite) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _d1_sync_state (table_name TEXT PRIMARY KEY, watermark TEXT)`);
}
function getWatermark(sqlite, table) {
  return sqlite.prepare(`SELECT watermark FROM _d1_sync_state WHERE table_name=?`).get(table)?.watermark ?? null;
}
function setWatermark(sqlite, table, value) {
  if (value == null) return;
  sqlite.prepare(`INSERT INTO _d1_sync_state (table_name, watermark) VALUES (?,?)
    ON CONFLICT(table_name) DO UPDATE SET watermark=excluded.watermark`).run(table, String(value));
}

async function syncTable(env, sqlite, spec, { full }) {
  const { name, incremental } = spec;
  if (!tableExistsLocally(sqlite, name)) {
    console.log(`[d1-sync] skip ${name} (not present locally)`);
    return { table: name, rows: 0, skipped: true };
  }
  const cols = columnsOf(sqlite, name);
  const colList = cols.join(', ');
  // Only use an incremental column that actually exists; otherwise full re-upsert.
  const inc = (incremental && cols.includes(incremental)) ? incremental : null;
  const watermark = (!full && inc) ? getWatermark(sqlite, name) : null;

  let select = `SELECT ${colList} FROM ${name}`;
  const selParams = [];
  if (watermark != null) { select += ` WHERE ${inc} > ?`; selParams.push(watermark); }
  if (inc) select += ` ORDER BY ${inc} ASC`;
  const rows = sqlite.prepare(select).all(...selParams);

  if (!rows.length) { console.log(`[d1-sync] ${name}: up to date`); return { table: name, rows: 0 }; }

  const batchSize = Math.max(1, Math.floor(PARAM_CAP / cols.length));
  const placeholderRow = `(${cols.map(() => '?').join(',')})`;
  let synced = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const sql = `INSERT OR REPLACE INTO ${name} (${colList}) VALUES ${batch.map(() => placeholderRow).join(',')}`;
    const params = batch.flatMap(r => cols.map(c => r[c] ?? null));
    await d1Query(env, sql, params);
    synced += batch.length;
  }
  // Advance watermark to the max incremental value we just pushed.
  if (inc) setWatermark(sqlite, name, rows[rows.length - 1][inc]);
  console.log(`[d1-sync] ${name}: ${synced} rows`);
  return { table: name, rows: synced };
}

async function main() {
  const { full, dry, only } = parseArgs(process.argv.slice(2));
  const env = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    dbId: process.env.D1_DATABASE_ID,
    dry,
  };
  if (!dry && (!env.accountId || !env.apiToken || !env.dbId)) {
    console.error('[d1-sync] CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID required (or pass --dry-run)');
    process.exit(1);
  }
  const sqlite = openDb();
  ensureSyncState(sqlite);

  const specs = only ? TABLES.filter(t => only.has(t.name)) : TABLES;
  let total = 0;
  for (const spec of specs) {
    const res = await syncTable(env, sqlite, spec, { full });
    total += res.rows;
  }
  sqlite.close();
  console.log(`[d1-sync] done: ${total} rows ${dry ? 'validated (dry-run)' : 'synced'} (${full ? 'full' : 'incremental'})`);
  return { items: total };
}

withHealth('d1_sync', main).catch(e => {
  console.error('[d1-sync] FAIL:', e.message);
  process.exit(1);
});
