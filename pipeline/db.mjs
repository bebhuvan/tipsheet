// SQLite handle + schema. Schema is portable to Cloudflare D1 (same SQL dialect).
// On D1, swap `better-sqlite3` for `env.DB.prepare(...)` calls; everything else carries over.

import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let _db;

export function openDb(path = process.env.DB_PATH || DEFAULT_DB) {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  _db['exec'](schemaSql);
  // Lightweight migrations: add columns that didn't exist in earlier schema versions.
  migrateAddColumn(_db, 'filings_enriched', 'the_full_read', 'TEXT');
  migrateAddColumn(_db, 'filings_enriched', 'editorial_tone', 'TEXT');
  migrateAddColumn(_db, 'filings_enriched', 'tone_score', 'INTEGER');
  migrateAddColumn(_db, 'filings_enriched', 'tone_confidence', 'TEXT');
  migrateAddColumn(_db, 'filings_enriched', 'tone_reason', 'TEXT');
  migrateAddColumn(_db, 'fundamentals', 'tijori_slug', 'TEXT');
  return _db;
}

function migrateAddColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(column)) {
    db['exec'](`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// ─── queries ────────────────────────────────────────────────────────

export function hasRecord(db, recordId) {
  return !!db.prepare('SELECT 1 FROM filings_raw WHERE record_id = ?').get(recordId);
}

const _insertRaw = (db) => db.prepare(`
  INSERT OR IGNORE INTO filings_raw
    (record_id, symbol, scripcode, company, score, sentiment, event_type,
     event_category_raw, event_category_canonical, rationale, news_summary,
     major_order, major_order_size, famous_investor_meeting, investor_name,
     concall_to_join, created_on, raw_json, inserted_at)
  VALUES
    (@record_id, @symbol, @scripcode, @company, @score, @sentiment, @event_type,
     @event_category_raw, @event_category_canonical, @rationale, @news_summary,
     @major_order, @major_order_size, @famous_investor_meeting, @investor_name,
     @concall_to_join, @created_on, @raw_json, @inserted_at)
`);
export function insertRaw(db, row) {
  return _insertRaw(db).run({ inserted_at: Date.now(), ...row });
}

const _insertEnriched = (db) => db.prepare(`
  INSERT OR REPLACE INTO filings_enriched
    (record_id, headline, dek, the_number_value, the_number_label,
     whats_new, why_it_matters, what_were_watching, the_full_read,
     editorial_tone, tone_score, tone_confidence, tone_reason,
     canonical_category, sector, key_entities, model_used, prompt_version,
     enriched_at, validation_ok, validation_issues)
  VALUES
    (@record_id, @headline, @dek, @the_number_value, @the_number_label,
     @whats_new, @why_it_matters, @what_were_watching, @the_full_read,
     @editorial_tone, @tone_score, @tone_confidence, @tone_reason,
     @canonical_category, @sector, @key_entities, @model_used, @prompt_version,
     @enriched_at, @validation_ok, @validation_issues)
`);
export function insertEnriched(db, row) {
  return _insertEnriched(db).run({ enriched_at: Date.now(), ...row });
}

export function listUnenriched(db, scoreMin = 5, limit = 200) {
  return db.prepare(`
    SELECT r.* FROM filings_raw r
    LEFT JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.score >= ? AND e.record_id IS NULL
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(scoreMin, limit);
}

export function listEnriched(db, { limit = 50, scoreMin = 5, category = null } = {}) {
  const where = ['r.score >= ?', 'e.validation_ok = 1'];
  const params = [scoreMin];
  if (category) { where.push('e.canonical_category = ?'); params.push(category); }
  return db.prepare(`
    SELECT r.*, e.headline, e.dek, e.the_number_value, e.the_number_label,
           e.whats_new, e.why_it_matters, e.what_were_watching, e.the_full_read,
           e.canonical_category, e.sector, e.key_entities, e.model_used
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(...params, limit);
}

// ─── concalls ───────────────────────────────────────────────────────

const _insertConcall = (db) => db.prepare(`
  INSERT OR IGNORE INTO concalls_raw
    (isin, event_time, symbol, company_name, sector, slug, status,
     recording_url, transcript_url, transcript_source, summary_highlight,
     management_consistency, ai_summary, raw_json, fetched_at)
  VALUES
    (@isin, @event_time, @symbol, @company_name, @sector, @slug, @status,
     @recording_url, @transcript_url, @transcript_source, @summary_highlight,
     @management_consistency, @ai_summary, @raw_json, @fetched_at)
`);
const _updateConcallSymbol = (db) => db.prepare(`UPDATE concalls_raw SET symbol = ? WHERE isin = ? AND symbol IS NULL`);
const _isinToSymbol = (db) => db.prepare(`SELECT symbol FROM fundamentals WHERE isin = ? LIMIT 1`);

/** Resolve a Tijori isin to our local NSE symbol (via fundamentals.isin). Returns null if unmapped. */
export function isinToSymbol(db, isin) {
  if (!isin) return null;
  const r = _isinToSymbol(db).get(isin);
  return r?.symbol || null;
}

/**
 * Upsert a batch of concall rows. Maps isin → symbol on the fly. Returns counts.
 * Idempotent: PRIMARY KEY (isin, event_time) means re-running is a no-op.
 */
export function insertConcalls(db, rows) {
  const insert = _insertConcall(db);
  const fixSym = _updateConcallSymbol(db);
  let inserted = 0, mapped = 0, unmapped = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      const symbol = r.symbol || isinToSymbol(db, r.isin);
      if (symbol) mapped++; else unmapped++;
      const info = insert.run({ ...r, symbol, fetched_at: Date.now() });
      if (info.changes > 0) inserted++;
      // Heal previously-unmapped rows if a fundamentals update later resolved the isin
      if (symbol && !r.symbol) fixSym.run(symbol, r.isin);
    }
  });
  tx(rows);
  return { inserted, mapped, unmapped, total: rows.length };
}

export function concallStats(db) {
  return {
    total:    db.prepare('SELECT COUNT(*) AS c FROM concalls_raw').get().c,
    mapped:   db.prepare('SELECT COUNT(*) AS c FROM concalls_raw WHERE symbol IS NOT NULL').get().c,
    unmapped: db.prepare('SELECT COUNT(*) AS c FROM concalls_raw WHERE symbol IS NULL').get().c,
    enriched: db.prepare('SELECT COUNT(*) AS c FROM concalls_enriched WHERE validation_ok = 1').get().c,
    with_mgmt_flag: db.prepare("SELECT COUNT(*) AS c FROM concalls_raw WHERE management_consistency IS NOT NULL AND management_consistency != ''").get().c,
    latest_event:   db.prepare('SELECT MAX(event_time) AS t FROM concalls_raw').get().t,
  };
}

const _listUnenrichedConcalls = (db, limit) => db.prepare(`
  SELECT r.* FROM concalls_raw r
  LEFT JOIN concalls_enriched e ON e.isin = r.isin AND e.event_time = r.event_time
  WHERE e.isin IS NULL
    AND r.status = 'recorded'
    AND r.ai_summary IS NOT NULL AND r.ai_summary != ''
  ORDER BY r.event_time DESC
  LIMIT ?
`).all(limit);
export function listUnenrichedConcalls(db, limit = 50) {
  return _listUnenrichedConcalls(db, limit);
}

const _insertEnrichedConcall = (db) => db.prepare(`
  INSERT OR REPLACE INTO concalls_enriched
    (isin, event_time, headline, dek, the_take, inconsistency_flag,
     whats_new, key_quotes, the_brief, canonical_category,
     model_used, prompt_version, enriched_at, validation_ok, validation_issues)
  VALUES
    (@isin, @event_time, @headline, @dek, @the_take, @inconsistency_flag,
     @whats_new, @key_quotes, @the_brief, @canonical_category,
     @model_used, @prompt_version, @enriched_at, @validation_ok, @validation_issues)
`);
export function insertEnrichedConcall(db, row) {
  return _insertEnrichedConcall(db).run({ enriched_at: Date.now(), ...row });
}

// ─── briefings (The Open / The Close) ───────────────────────────────

const _upsertBriefing = (db) => db.prepare(`
  INSERT OR REPLACE INTO briefings
    (type, date, headline, dek, the_take, sections, input_summary,
     generated_at, model_used, prompt_version, validation_ok, validation_issues)
  VALUES
    (@type, @date, @headline, @dek, @the_take, @sections, @input_summary,
     @generated_at, @model_used, @prompt_version, @validation_ok, @validation_issues)
`);
export function upsertBriefing(db, row) {
  return _upsertBriefing(db).run({ generated_at: Date.now(), ...row });
}

export function getBriefing(db, type, date) {
  return db.prepare('SELECT * FROM briefings WHERE type = ? AND date = ?').get(type, date);
}

export function listRecentBriefings(db, limit = 30) {
  return db.prepare('SELECT type, date, headline, dek, the_take FROM briefings WHERE validation_ok = 1 ORDER BY date DESC, type ASC LIMIT ?').all(limit);
}

// ─── India Data Hub: macro calendar ─────────────────────────────────

const _insertMacroEvent = (db) => db.prepare(`
  INSERT OR REPLACE INTO macro_calendar
    (date, identifier, country_code, coverage, indicator, period, previous_val,
     forecast_val, actual_val, category, unit, frequency, impact, date_type,
     event_flag, raw_json, fetched_at)
  VALUES
    (@date, @identifier, @country_code, @coverage, @indicator, @period, @previous_val,
     @forecast_val, @actual_val, @category, @unit, @frequency, @impact, @date_type,
     @event_flag, @raw_json, @fetched_at)
`);
export function insertMacroEvents(db, rows) {
  const stmt = _insertMacroEvent(db);
  const tx = db.transaction((items) => {
    for (const r of items) stmt.run({
      identifier: null, country_code: null,  // PK columns must be non-undefined
      ...r,
      fetched_at: Date.now(),
    });
  });
  tx(rows);
  return rows.length;
}

export function macroCalendarStats(db) {
  return {
    total: db.prepare('SELECT COUNT(*) AS c FROM macro_calendar').get().c,
    india: db.prepare("SELECT COUNT(*) AS c FROM macro_calendar WHERE country_code = 'IN'").get().c,
    high_impact: db.prepare("SELECT COUNT(*) AS c FROM macro_calendar WHERE impact = 'H'").get().c,
    latest: db.prepare('SELECT MAX(date) AS d FROM macro_calendar').get().d,
  };
}

// ─── fundamentals ───────────────────────────────────────────────────

const _upsertFundamental = (db) => db.prepare(`
  INSERT INTO fundamentals
    (symbol, isin, sector, market_cap, pe, roe, debt_to_equity, dividend_yield,
     free_cash_flow, revenue_growth, pat_growth, low_52w, high_52w, tijori_slug, raw_json, fetched_at)
  VALUES
    (@symbol, @isin, @sector, @market_cap, @pe, @roe, @debt_to_equity, @dividend_yield,
     @free_cash_flow, @revenue_growth, @pat_growth, @low_52w, @high_52w, @tijori_slug, @raw_json, @fetched_at)
  ON CONFLICT(symbol) DO UPDATE SET
    isin=excluded.isin, sector=excluded.sector, market_cap=excluded.market_cap,
    pe=excluded.pe, roe=excluded.roe, debt_to_equity=excluded.debt_to_equity,
    dividend_yield=excluded.dividend_yield, free_cash_flow=excluded.free_cash_flow,
    revenue_growth=excluded.revenue_growth, pat_growth=excluded.pat_growth,
    low_52w=excluded.low_52w, high_52w=excluded.high_52w,
    tijori_slug=COALESCE(excluded.tijori_slug, fundamentals.tijori_slug),
    raw_json=excluded.raw_json, fetched_at=excluded.fetched_at
`);
export function upsertFundamentals(db, rows) {
  const stmt = _upsertFundamental(db);
  const tx = db.transaction((items) => {
    for (const r of items) stmt.run({ fetched_at: Date.now(), ...r });
  });
  tx(rows);
  return rows.length;
}

export function getFundamental(db, symbol) {
  return db.prepare('SELECT * FROM fundamentals WHERE symbol = ?').get(symbol);
}

export function listCompaniesNeedingTijoriSlug(db, limit = 100) {
  return db.prepare(`
    SELECT r.symbol, MAX(r.company) AS company
    FROM filings_raw r
    INNER JOIN fundamentals f ON f.symbol = r.symbol
    WHERE r.symbol IS NOT NULL
      AND r.company IS NOT NULL
      AND r.company != ''
      AND (f.tijori_slug IS NULL OR f.tijori_slug = '')
    GROUP BY r.symbol
    ORDER BY MAX(r.created_on) DESC
    LIMIT ?
  `).all(limit);
}

const _setTijoriSlug = (db) => db.prepare(`
  UPDATE fundamentals
  SET tijori_slug = ?
  WHERE symbol = ?
`);
export function setTijoriSlug(db, symbol, slug) {
  if (!symbol || !slug) return { changes: 0 };
  return _setTijoriSlug(db).run(slug, symbol);
}

// ─── Radar ──────────────────────────────────────────────────────────

// One-shot migration: add why_now_hash + why_now_source if missing. Idempotent.
let _radarMigrated = false;
function ensureRadarMigrations(db) {
  if (_radarMigrated) return;
  const cols = db.prepare(`PRAGMA table_info(radar_items)`).all().map(c => c.name);
  if (!cols.includes('why_now_hash'))   db.prepare(`ALTER TABLE radar_items ADD COLUMN why_now_hash TEXT`).run();
  if (!cols.includes('why_now_source')) db.prepare(`ALTER TABLE radar_items ADD COLUMN why_now_source TEXT DEFAULT 'template'`).run();
  _radarMigrated = true;
}

const _upsertRadarItem = (db) => db.prepare(`
  INSERT INTO radar_items
    (symbol, company, trigger_type, title, why_now, evidence_record_ids,
     quality_flags, risk_flags, radar_score, tijori_slug, status, generated_at, updated_at,
     why_now_hash, why_now_source)
  VALUES
    (@symbol, @company, @trigger_type, @title, @why_now, @evidence_record_ids,
     @quality_flags, @risk_flags, @radar_score, @tijori_slug, @status, @generated_at, @updated_at,
     @why_now_hash, @why_now_source)
  ON CONFLICT(symbol, trigger_type) DO UPDATE SET
    company=excluded.company,
    title=excluded.title,
    why_now=excluded.why_now,
    evidence_record_ids=excluded.evidence_record_ids,
    quality_flags=excluded.quality_flags,
    risk_flags=excluded.risk_flags,
    radar_score=excluded.radar_score,
    tijori_slug=excluded.tijori_slug,
    status=excluded.status,
    updated_at=excluded.updated_at,
    why_now_hash=excluded.why_now_hash,
    why_now_source=excluded.why_now_source
`);

export function upsertRadarItems(db, rows) {
  ensureRadarMigrations(db);
  const stmt = _upsertRadarItem(db);
  const now = Date.now();
  const tx = db.transaction((items) => {
    for (const r of items) {
      stmt.run({
        status: 'active',
        generated_at: now,
        updated_at: now,
        why_now_hash: null,
        why_now_source: 'template',
        ...r,
        evidence_record_ids: JSON.stringify(r.evidence_record_ids || []),
        quality_flags: JSON.stringify(r.quality_flags || []),
        risk_flags: JSON.stringify(r.risk_flags || []),
      });
    }
  });
  tx(rows);
  return rows.length;
}

export function listExistingRadarItems(db) {
  ensureRadarMigrations(db);
  const rows = db.prepare(`
    SELECT symbol, trigger_type, why_now, why_now_hash, why_now_source
    FROM radar_items
  `).all();
  const map = new Map();
  for (const r of rows) map.set(`${r.symbol}::${r.trigger_type}`, r);
  return map;
}

export function deactivateStaleRadarItems(db, activeKeys) {
  const keys = new Set(activeKeys || []);
  const rows = db.prepare('SELECT symbol, trigger_type FROM radar_items WHERE status = ?').all('active');
  const stmt = db.prepare('UPDATE radar_items SET status = ?, updated_at = ? WHERE symbol = ? AND trigger_type = ?');
  const now = Date.now();
  let changed = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const key = `${r.symbol}::${r.trigger_type}`;
      if (!keys.has(key)) changed += stmt.run('stale', now, r.symbol, r.trigger_type).changes;
    }
  });
  tx();
  return changed;
}

export function listRadarSourceRows(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT r.record_id, r.symbol, r.company, r.score, r.event_type,
           r.event_category_raw, r.event_category_canonical,
           r.major_order, r.major_order_size, r.famous_investor_meeting,
           r.investor_name, r.created_on,
           e.headline, e.dek, e.canonical_category, e.sector,
           f.market_cap, f.pe, f.roe, f.debt_to_equity, f.dividend_yield,
           f.free_cash_flow, f.revenue_growth, f.pat_growth, f.low_52w,
           f.high_52w, f.tijori_slug
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    WHERE e.validation_ok = 1
      AND r.symbol IS NOT NULL
      AND substr(r.created_on, 1, 10) >= ?
    ORDER BY r.created_on DESC
  `).all(cutoff);
}

export function listRecentConcallFlags(db, days = 45) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT c.symbol, c.company_name, c.event_time, e.inconsistency_flag, e.headline
    FROM concalls_raw c
    JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE e.validation_ok = 1
      AND c.symbol IS NOT NULL
      AND e.inconsistency_flag IS NOT NULL
      AND e.inconsistency_flag != ''
      AND substr(c.event_time, 1, 10) >= ?
    ORDER BY c.event_time DESC
  `).all(cutoff);
}

export function fundamentalCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM fundamentals').get().c;
}

// ─── market snapshots ───────────────────────────────────────────────

const _insertSnapshot = (db) => db.prepare(`
  INSERT INTO market_snapshots
    (fetched_at, symbol, name, grp, price, change_abs, change_pct, prev_close,
     day_high, day_low, week52_high, week52_low, volume, currency, market_state, source, raw_json)
  VALUES
    (@fetched_at, @symbol, @name, @grp, @price, @change_abs, @change_pct, @prev_close,
     @day_high, @day_low, @week52_high, @week52_low, @volume, @currency, @market_state, @source, @raw_json)
`);
export function insertSnapshot(db, row) {
  return _insertSnapshot(db).run({ fetched_at: Date.now(), ...row });
}

export function insertSnapshots(db, rows) {
  const stmt = _insertSnapshot(db);
  const tx = db.transaction((items) => {
    for (const r of items) stmt.run({ fetched_at: Date.now(), ...r });
  });
  tx(rows);
  return rows.length;
}

// ─── market history (sparkline data) ────────────────────────────────

const _insertHistoryPoint = (db) => db.prepare(`
  INSERT OR REPLACE INTO market_history (symbol, date, close) VALUES (?, ?, ?)
`);

export function insertHistoryBatch(db, series) {
  const stmt = _insertHistoryPoint(db);
  const tx = db.transaction((items) => {
    for (const s of items) {
      for (const p of (s.points || [])) {
        stmt.run(s.symbol, p.date, p.close);
      }
    }
  });
  tx(series);
  return series.reduce((sum, s) => sum + (s.points?.length || 0), 0);
}

export function getHistory(db, symbol, days = 30) {
  return db.prepare(`
    SELECT date, close FROM market_history
    WHERE symbol = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(symbol, days).reverse();
}

/** Latest snapshot for each symbol — driven by an optional group filter. */
export function getLatestSnapshots(db, { group = null, maxAgeMs = null } = {}) {
  let sql = `
    SELECT s.* FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t
      FROM market_snapshots
      GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
  `;
  const conds = [];
  const params = [];
  if (group) { conds.push('s.grp = ?'); params.push(group); }
  if (maxAgeMs) { conds.push('s.fetched_at >= ?'); params.push(Date.now() - maxAgeMs); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY s.grp, s.symbol';
  return db.prepare(sql).all(...params);
}

export function stats(db) {
  return {
    raw: db.prepare('SELECT COUNT(*) AS c FROM filings_raw').get().c,
    enriched_ok:   db.prepare('SELECT COUNT(*) AS c FROM filings_enriched WHERE validation_ok = 1').get().c,
    enriched_fail: db.prepare('SELECT COUNT(*) AS c FROM filings_enriched WHERE validation_ok = 0').get().c,
    score_dist:    db.prepare('SELECT score, COUNT(*) AS c FROM filings_raw GROUP BY score ORDER BY score').all(),
    by_category:   db.prepare('SELECT event_category_canonical AS cat, COUNT(*) AS c FROM filings_raw GROUP BY event_category_canonical ORDER BY c DESC').all(),
  };
}
