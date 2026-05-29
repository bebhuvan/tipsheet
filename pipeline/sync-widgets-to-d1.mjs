// Sync tijori_widgets from local SQLite to Cloudflare D1.
// Run after tijori_widgets.py refreshes the cache.
// Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID in env.

import { openDb, withHealth } from './db.mjs';

const D1_DATABASE_ID = '4645967f-e1aa-4291-b023-5509fcddb758';

async function d1Query(accountId, apiToken, sql, params = []) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`D1 API error ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error('[widgets-sync] CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN required');
    process.exit(1);
  }

  const sqlite = openDb();
  const rows = sqlite.prepare('SELECT * FROM tijori_widgets ORDER BY symbol').all();
  console.log(`[widgets-sync] local rows: ${rows.length}`);

  if (rows.length === 0) {
    console.log('[widgets-sync] nothing to sync');
    return;
  }

  // CREATE TABLE if not exists (idempotent)
  await d1Query(accountId, apiToken, `
    CREATE TABLE IF NOT EXISTS tijori_widgets (
      symbol TEXT PRIMARY KEY,
      slug TEXT,
      company_name TEXT,
      payload_json TEXT NOT NULL,
      schema_version TEXT,
      source_run_id TEXT,
      fetched_at INTEGER NOT NULL
    )
  `);

  // Batch upsert in groups of 25 (D1 API limits)
  // D1 caps bound parameters at ~100/query; 7 cols → keep rows*7 under that.
  const BATCH = 12;
  let synced = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const values = batch.flatMap(r => [
      r.symbol, r.slug, r.company_name, r.payload_json,
      r.schema_version, r.source_run_id, r.fetched_at,
    ]);

    const sql = `
      INSERT OR REPLACE INTO tijori_widgets
        (symbol, slug, company_name, payload_json, schema_version, source_run_id, fetched_at)
      VALUES ${placeholders}
    `;

    await d1Query(accountId, apiToken, sql, values);
    synced += batch.length;
    console.log(`[widgets-sync] batch ${Math.ceil((i + 1) / BATCH)}: ${synced}/${rows.length}`);
  }

  console.log(`[widgets-sync] done: ${synced} rows synced to D1`);
  sqlite.close();
}

withHealth('tijori_widgets_sync', main).catch(e => {
  console.error('[widgets-sync] FAIL:', e.message);
  process.exit(1);
});
