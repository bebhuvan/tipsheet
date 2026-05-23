// Read-only queries against the shared SQLite DB written by the pipeline.
// In production (Cloudflare D1), these functions are replaced with `env.DB.prepare(...).all()`
// — same SQL, different handle. The query module is the swap boundary.

import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../../../data/filings.db');

let _db;
function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ─── helpers ────────────────────────────────────────────────────────

function parseJsonArray(s) { try { return s ? JSON.parse(s) : []; } catch { return []; } }
function parseJsonObject(s) { try { const v = s ? JSON.parse(s) : null; return v && typeof v === 'object' ? v : null; } catch { return null; } }

const tablePresence = new Map();
function hasTable(name) {
  if (tablePresence.has(name)) return tablePresence.get(name);
  const row = db().prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  const found = !!row;
  tablePresence.set(name, found);
  return found;
}

function shapeFiling(row) {
  if (!row) return null;
  return {
    record_id:          row.record_id,
    symbol:             row.symbol,
    scripcode:          row.scripcode,
    company:            row.company,
    score:              row.score,
    sentiment:          row.sentiment,
    event_type:         row.event_type,
    event_category_raw: row.event_category_raw,
    canonical_category: row.canonical_category,
    sector:             row.sector,
    created_on:         row.created_on,
    headline:           row.headline,
    dek:                row.dek,
    the_number: {
      value: row.the_number_value,
      label: row.the_number_label,
    },
    whats_new:          parseJsonArray(row.whats_new),
    why_it_matters:     row.why_it_matters,
    what_were_watching: parseJsonArray(row.what_were_watching),
    faqs:               parseJsonArray(row.faqs),
    the_full_read:      row.the_full_read,
    editorial_tone:     row.editorial_tone,
    tone_score:         row.tone_score,
    tone_confidence:    row.tone_confidence,
    tone_reason:        row.tone_reason,
    key_entities:       parseJsonArray(row.key_entities),
    slug:               buildSlug(row.symbol, row.headline, row.record_id),
    canonical_url:      `/${buildSlug(row.symbol, row.headline, row.record_id)}/`,
  };
}

export function buildSlug(symbol, headline, recordId) {
  const sym = String(symbol || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hd = String(headline || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return hd ? `${sym}-${hd}-${recordId}` : `${sym}-${recordId}`;
}

/**
 * Derive primary-source filing pages from what the Tijori feed gives us.
 *
 * Tijori does NOT include the source URL today (we should request it upstream).
 * Until then, we deep-link to the company's announcements index — the reader is
 * one click from the specific filing, and the citation chain is preserved.
 *
 * BSE: announcements page filtered by scripcode (most precise we can manage).
 * NSE: company announcements filtered by symbol.
 */
export function sourceLinks(filing) {
  if (!filing) return {};
  const scripcode = filing.scripcode;
  const symbol = filing.symbol;
  const links = {};
  if (scripcode) {
    links.bse_announcements = `https://www.bseindia.com/corporates/ann.html?scrip=${scripcode}&dur=A`;
    links.bse_company = `https://www.bseindia.com/stock_information.aspx?scripcd=${scripcode}`;
  }
  if (symbol) {
    const enc = encodeURIComponent(symbol);
    links.nse_announcements = `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${enc}`;
    links.nse_company = `https://www.nseindia.com/get-quotes/equity?symbol=${enc}`;
  }
  return links;
}

export function tijoriCompanyUrl(fundamental) {
  const slug = fundamental?.tijori_slug;
  if (!slug) return null;
  return `https://www.tijorifinance.com/company/${encodeURIComponent(slug)}/`;
}

// Parse slug `xyz-123` → record_id
export function recordIdFromSlug(slug) {
  const m = String(slug || '').match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ─── public queries ─────────────────────────────────────────────────

const ALL_COLS = `
  r.record_id, r.symbol, r.scripcode, r.company, r.score, r.sentiment,
  r.event_type, r.event_category_raw, r.event_category_canonical AS canonical_category,
  e.sector, r.created_on,
  e.headline, e.dek, e.the_number_value, e.the_number_label,
  e.whats_new, e.why_it_matters, e.what_were_watching, e.faqs, e.the_full_read,
  e.editorial_tone, e.tone_score, e.tone_confidence, e.tone_reason,
  e.key_entities
`;

/** All publishable filings ordered newest first, optionally filtered. */
export function listFilings({ limit = 100, scoreMin = 5, category = null } = {}) {
  const where = ['r.score >= ?', 'e.validation_ok = 1'];
  const params = [scoreMin];
  if (category) { where.push('e.canonical_category = ?'); params.push(category); }
  const sql = `
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_on DESC
    LIMIT ?
  `;
  return db().prepare(sql).all(...params, limit).map(shapeFiling);
}

/** Single filing by record_id. */
export function getFiling(recordId) {
  if (!recordId) return null;
  const sql = `
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.record_id = ? AND e.validation_ok = 1
  `;
  return shapeFiling(db().prepare(sql).get(recordId));
}

/** Story-so-far: prior filings for the same symbol. */
export function priorFilingsForSymbol(symbol, excludeRecordId, limit = 5) {
  if (!symbol) return [];
  return db().prepare(`
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.symbol = ? AND r.record_id <> ? AND e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(symbol, excludeRecordId, limit).map(shapeFiling);
}

/** Homepage data bundle: lead + secondaries + midtier + briefs + wire. */
export function getHomepageBundle() {
  const top = listFilings({ limit: 160 });
  const sorted = [...top].sort((a, b) => b.score - a.score || (a.created_on < b.created_on ? 1 : -1));
  const lead = sorted[0] || null;
  const secondaries = sorted.slice(1, 4);

  // Mid-tier: 6 items mixed across categories so the strip below the hero
  // doesn't collapse into one section's filings. Greedy round-robin picker.
  const heroIds = new Set([lead?.record_id, ...secondaries.map(f => f.record_id)].filter(Boolean));
  const remaining = sorted.filter(f => !heroIds.has(f.record_id));
  const seenCats = new Map();
  const midtier = [];
  // 2 used as lead-companions + 6 in the "Also today" 3×2 grid below the hero.
  const MIDTIER_TARGET = 8;
  for (let pass = 1; pass <= 4 && midtier.length < MIDTIER_TARGET; pass++) {
    for (const f of remaining) {
      if (midtier.length >= MIDTIER_TARGET) break;
      if (midtier.includes(f)) continue;
      const cat = f.canonical_category || f.event_type || 'Other';
      const count = seenCats.get(cat) || 0;
      if (count < pass) {
        midtier.push(f);
        seenCats.set(cat, count + 1);
      }
    }
  }

  // Lead companions: the next 2 items, shown below the lead in the lead column
  // so the wide hero-lead block isn't visually empty next to the stacked rail.
  const leadCompanions = midtier.slice(0, 2);
  const midtierRest    = midtier.slice(2);

  const usedIds = new Set([...heroIds, ...midtier.map(f => f.record_id)]);
  const wire = top.filter(f => !usedIds.has(f.record_id)).slice(0, 60);

  const cats = ['Earnings', 'Order Wins', 'Concalls', 'M&A', 'Credit', 'Regulatory'];
  const briefs = cats.map(cat => ({
    name: cat,
    total: countByCategory(cat),
    items: listFilings({ limit: 3, category: cat }),
  })).filter(b => b.items.length > 0);

  const dist = db().prepare(`
    SELECT r.score AS score, COUNT(*) AS c
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.score >= 5 AND e.validation_ok = 1
    GROUP BY r.score
    ORDER BY r.score
  `).all();

  const totalToday = db().prepare(`SELECT COUNT(*) AS c FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id WHERE e.validation_ok = 1`).get().c;
  const hiScore = db().prepare(`SELECT COUNT(*) AS c FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id WHERE r.score >= 8 AND e.validation_ok = 1`).get().c;

  return { lead, secondaries, leadCompanions, midtier: midtierRest, briefs, wire, dist, totalToday, hiScore };
}

function countByCategory(cat) {
  return db().prepare(`
    SELECT COUNT(*) AS c FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.canonical_category = ? AND e.validation_ok = 1
  `).get(cat).c;
}

// ─── market snapshots ───────────────────────────────────────────────

/** Historical close prices for a symbol — for sparkline rendering. */
export function getMarketHistory(symbol, days = 30) {
  return db().prepare(`
    SELECT date, close FROM market_history
    WHERE symbol = ?
    ORDER BY date DESC
    LIMIT ?
  `).all(symbol, days).reverse();
}

/** Bulk: history for many symbols, returned as a Map. */
export function getMarketHistoryBulk(symbols, days = 30) {
  if (!Array.isArray(symbols) || symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db().prepare(`
    SELECT symbol, date, close FROM market_history
    WHERE symbol IN (${placeholders})
    ORDER BY symbol, date DESC
  `).all(...symbols);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.symbol)) map.set(r.symbol, []);
    if (map.get(r.symbol).length < days) map.get(r.symbol).push(r);
  }
  // reverse to chronological
  for (const [k, v] of map) map.set(k, v.reverse());
  return map;
}

/** Latest snapshot per symbol, optionally filtered by group ('broad' | 'sector' | 'fx' | 'commodity'). */
export function getLatestMarketSnapshots(group = null) {
  let sql = `
    SELECT s.* FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t
      FROM market_snapshots GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
  `;
  const params = [];
  if (group) { sql += ' WHERE s.grp = ?'; params.push(group); }
  sql += ' ORDER BY s.grp, s.symbol';
  return db().prepare(sql).all(...params);
}

/** Top N sectoral indices ranked by absolute change_pct (biggest movers, up or down). */
export function topSectorMovers(n = 5) {
  return db().prepare(`
    SELECT s.* FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t FROM market_snapshots WHERE grp = 'sector' GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
    WHERE s.grp = 'sector' AND s.change_pct IS NOT NULL
    ORDER BY ABS(s.change_pct) DESC
    LIMIT ?
  `).all(n);
}

// ─── fundamentals ───────────────────────────────────────────────────

export function getFundamentals(symbol) {
  if (!symbol) return null;
  return db().prepare('SELECT * FROM fundamentals WHERE symbol = ?').get(symbol);
}

export function getTijoriWidget(symbol) {
  if (!symbol || !hasTable('tijori_widgets')) return null;
  const row = db().prepare('SELECT * FROM tijori_widgets WHERE symbol = ?').get(symbol);
  if (!row) return null;
  return {
    ...row,
    payload: parseJsonObject(row.payload_json),
  };
}

export function getFundamentalContext(symbol, sector) {
  if (!symbol || !sector) return null;
  const rows = db().prepare(`
    SELECT pe, roe, debt_to_equity, revenue_growth, pat_growth, dividend_yield
    FROM fundamentals
    WHERE sector = ?
  `).all(sector);
  const rank = db().prepare(`
    SELECT COUNT(*) + 1 AS market_cap_rank
    FROM fundamentals current
    JOIN fundamentals peer ON peer.sector = current.sector
    WHERE current.symbol = ?
      AND current.market_cap IS NOT NULL
      AND peer.market_cap IS NOT NULL
      AND peer.market_cap > current.market_cap
  `).get(symbol);

  const nums = (key, accept = () => true) => rows
    .map(row => Number(row[key]))
    .filter(n => Number.isFinite(n) && accept(n))
    .sort((a, b) => a - b);
  const median = (values) => {
    if (!values.length) return null;
    const mid = Math.floor(values.length / 2);
    const v = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    return Math.round(v * 100) / 100;
  };

  return {
    sector_count: rows.length,
    median_pe: median(nums('pe', n => n > 0 && n < 500)),
    median_roe: median(nums('roe', n => n > -100 && n < 100)),
    median_debt_to_equity: median(nums('debt_to_equity', n => n >= 0 && n < 20)),
    median_revenue_growth: median(nums('revenue_growth', n => n > -100 && n < 500)),
    median_pat_growth: median(nums('pat_growth', n => n > -100 && n < 500)),
    median_dividend_yield: median(nums('dividend_yield', n => n >= 0 && n < 50)),
    ...rank,
  };
}

/** Smart-money filings: promoter activity, insider trades, M&A, famous-investor flags. */
export function smartMoneyFilings(limit = 100) {
  return db().prepare(`
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
      AND (
        e.canonical_category = 'M&A'
        OR LOWER(r.event_type) LIKE '%acquisition%'
        OR LOWER(r.event_category_raw) LIKE '%pledge%'
        OR LOWER(r.event_category_raw) LIKE '%warrant%'
        OR LOWER(r.event_category_raw) LIKE '%designated person%'
        OR r.famous_investor_meeting = 1
      )
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(limit).map(shapeFiling);
}

// ─── per-company queries ────────────────────────────────────────────

/** All filings for a single symbol — used by company timeline page. */
export function filingsForCompany(symbol, limit = 100) {
  if (!symbol) return [];
  return db().prepare(`
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.symbol = ? AND e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(symbol, limit).map(shapeFiling);
}

/** Total number of published filings for a symbol. */
export function filingsCountForSymbol(symbol) {
  if (!symbol) return 0;
  const row = db().prepare(`
    SELECT COUNT(*) AS c
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.symbol = ? AND e.validation_ok = 1
  `).get(symbol);
  return row?.c || 0;
}

/** Symbols that have at least one published filing — used for company-page generation. */
export function distinctSymbolsWithFilings() {
  return db().prepare(`
    SELECT DISTINCT r.symbol, r.company
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1 AND r.symbol IS NOT NULL
    ORDER BY r.symbol
  `).all();
}

/** Companies with filings + counts, joined with fundamentals for sector and market cap. */
export function listAllCompanies() {
  return db().prepare(`
    SELECT r.symbol, r.company,
           COUNT(*) AS article_count,
           MAX(r.created_on) AS latest,
           f.sector AS sector, f.market_cap AS market_cap
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    WHERE e.validation_ok = 1 AND r.symbol IS NOT NULL
    GROUP BY r.symbol
    ORDER BY r.company COLLATE NOCASE
  `).all();
}

/** All sectors with activity, joined with article + company counts. */
export function listAllSectors() {
  return db().prepare(`
    SELECT f.sector,
           COUNT(DISTINCT r.symbol) AS company_count,
           COUNT(*) AS article_count,
           SUM(f.market_cap) AS total_mcap
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    INNER JOIN fundamentals f ON f.symbol = r.symbol
    WHERE e.validation_ok = 1 AND f.sector IS NOT NULL
    GROUP BY f.sector
    ORDER BY f.sector COLLATE NOCASE
  `).all();
}

/** Distinct sectors (from fundamentals) with at least one filing among the symbols in that sector. */
export function distinctSectorsWithFilings() {
  return db().prepare(`
    SELECT DISTINCT f.sector
    FROM fundamentals f
    INNER JOIN (
      SELECT DISTINCT r.symbol FROM filings_raw r
      JOIN filings_enriched e ON e.record_id = r.record_id
      WHERE e.validation_ok = 1
    ) filed ON filed.symbol = f.symbol
    WHERE f.sector IS NOT NULL
    ORDER BY f.sector
  `).all();
}

/** Filings for all companies in a sector. */
export function filingsForSector(sector, limit = 50) {
  if (!sector) return [];
  return db().prepare(`
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    INNER JOIN fundamentals f ON f.symbol = r.symbol
    WHERE f.sector = ? AND e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(sector, limit).map(shapeFiling);
}

/** Companies in a sector (anchor list for sector page). */
export function companiesInSector(sector, limit = 50) {
  if (!sector) return [];
  return db().prepare(`
    SELECT f.symbol, f.market_cap, f.pe, f.roe, f.low_52w, f.high_52w
    FROM fundamentals f
    WHERE f.sector = ? AND f.market_cap IS NOT NULL
    ORDER BY f.market_cap DESC
    LIMIT ?
  `).all(sector, limit);
}

// Build a sector slug like "it-software" from "IT - Software"
export function sectorSlug(sector) {
  return String(sector || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Resolve a sector slug back to its canonical name. */
export function sectorBySlug(slug) {
  const all = db().prepare('SELECT DISTINCT sector FROM fundamentals WHERE sector IS NOT NULL').all();
  return all.find(r => sectorSlug(r.sector) === slug)?.sector || null;
}

// ─── tiered article label ───────────────────────────────────────────

export function tierFor(score) {
  if (score >= 9) return 'Alert';
  if (score >= 7) return 'Lead';
  return 'Brief';
}

/** Sector aggregates for Market Data page. */
export function sectorAggregates({ minMcap = 0, limit = 40 } = {}) {
  return db().prepare(`
    SELECT sector,
           COUNT(*) AS company_count,
           ROUND(AVG(pe), 2)  AS avg_pe,
           ROUND(AVG(roe), 2) AS avg_roe,
           ROUND(SUM(market_cap), 0) AS total_mcap,
           ROUND(AVG(debt_to_equity), 2) AS avg_de
    FROM fundamentals
    WHERE sector IS NOT NULL AND market_cap > ?
    GROUP BY sector
    ORDER BY total_mcap DESC
    LIMIT ?
  `).all(minMcap, limit);
}

/** Top N companies by market cap (anchor names per sector). */
export function topByMarketCap(n = 20) {
  return db().prepare(`
    SELECT symbol, sector, market_cap, pe, roe, low_52w, high_52w
    FROM fundamentals
    WHERE market_cap IS NOT NULL
    ORDER BY market_cap DESC
    LIMIT ?
  `).all(n);
}

// ─── briefings (The Open / The Close) ───────────────────────────────

function shapeBriefing(row) {
  if (!row) return null;
  let sections = [];
  try { sections = JSON.parse(row.sections || '[]'); } catch {}
  return {
    type:           row.type,
    date:           row.date,
    headline:       row.headline,
    dek:            row.dek,
    the_take:       row.the_take,
    sections,
    generated_at:   row.generated_at,
    model_used:     row.model_used,
    canonical_url:  `/briefings/the-${row.type}/${row.date}/`,
    label:          row.type === 'open' ? 'The Open' : 'The Close',
  };
}

export function getBriefing(type, dateYmd) {
  if (!type || !dateYmd) return null;
  const row = db().prepare('SELECT * FROM briefings WHERE type = ? AND date = ?').get(type, dateYmd);
  return shapeBriefing(row);
}

export function listBriefings(limit = 30) {
  return db().prepare('SELECT * FROM briefings ORDER BY date DESC, type ASC LIMIT ?').all(limit).map(shapeBriefing);
}

export function listAllBriefingsForStaticPaths() {
  return db().prepare('SELECT type, date FROM briefings').all();
}

export function getBriefingVisuals(type, dateYmd, focusRecordIds = []) {
  if (!dateYmd) {
    return { type, date: dateYmd, market: [], filings: [], categories: [], sectors: [], scoreBands: [] };
  }

  const start = new Date(`${dateYmd}T00:00:00+05:30`);
  if (Number.isNaN(start.valueOf())) {
    return { type, date: dateYmd, market: [], filings: [], categories: [], sectors: [], scoreBands: [] };
  }
  const end = new Date(start);
  if (type === 'close') end.setDate(end.getDate() + 1);
  else start.setDate(start.getDate() - 1);

  const startIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = end.toISOString().replace('T', ' ').slice(0, 19);
  const whereWindow = `e.validation_ok = 1 AND r.created_on >= ? AND r.created_on < ?`;
  const includeTijoriWidgets = hasTable('tijori_widgets');
  const tijoriWidgetCols = includeTijoriWidgets
    ? 'tw.payload_json AS tijori_widget_json, tw.fetched_at AS tijori_widget_fetched_at'
    : 'NULL AS tijori_widget_json, NULL AS tijori_widget_fetched_at';
  const tijoriWidgetJoin = includeTijoriWidgets
    ? 'LEFT JOIN tijori_widgets tw ON tw.symbol = r.symbol'
    : '';
  const filingCols = `
    r.record_id, r.symbol, r.company, r.score, r.event_type,
    r.event_category_canonical AS category, r.major_order, r.major_order_size,
    r.created_on, e.headline, e.dek, e.the_number_value, e.the_number_label,
    e.why_it_matters, f.sector, f.market_cap, f.pe, f.roe, f.debt_to_equity,
    f.revenue_growth, f.pat_growth, f.tijori_slug,
    ${tijoriWidgetCols}
  `;
  const filingJoins = `
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    ${tijoriWidgetJoin}
  `;
  const shapeBriefingVisualFiling = row => ({
    ...row,
    canonical_url: `/${buildSlug(row.symbol, row.headline, row.record_id)}/`,
  });

  const filings = db().prepare(`
    SELECT ${filingCols}
    ${filingJoins}
    WHERE ${whereWindow}
    ORDER BY r.score DESC, r.created_on DESC
    LIMIT 14
  `).all(startIso, endIso).map(shapeBriefingVisualFiling);

  const focusIds = Array.isArray(focusRecordIds)
    ? [...new Set(focusRecordIds.map(Number).filter(Number.isFinite))]
    : [];
  const focusFilings = focusIds.length
    ? db().prepare(`
        SELECT ${filingCols}
        ${filingJoins}
        WHERE e.validation_ok = 1 AND r.record_id IN (${focusIds.map(() => '?').join(',')})
      `).all(...focusIds).map(shapeBriefingVisualFiling)
    : [];
  const focusById = new Map(focusFilings.map(row => [row.record_id, row]));
  const orderedFocus = focusIds.map(id => focusById.get(id)).filter(Boolean);
  const focusSet = new Set(orderedFocus.map(row => row.record_id));
  const signalFilings = [
    ...orderedFocus,
    ...filings.filter(row => !focusSet.has(row.record_id)),
  ].slice(0, 14);

  const categories = db().prepare(`
    SELECT COALESCE(r.event_category_canonical, 'Other') AS name, COUNT(*) AS count,
           ROUND(AVG(r.score), 2) AS avg_score
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE ${whereWindow}
    GROUP BY COALESCE(r.event_category_canonical, 'Other')
    ORDER BY count DESC, avg_score DESC
    LIMIT 8
  `).all(startIso, endIso);

  const sectors = db().prepare(`
    SELECT COALESCE(f.sector, e.sector, 'Unclassified') AS name, COUNT(*) AS count,
           MAX(r.score) AS top_score
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    WHERE ${whereWindow}
    GROUP BY COALESCE(f.sector, e.sector, 'Unclassified')
    ORDER BY count DESC, top_score DESC
    LIMIT 8
  `).all(startIso, endIso);

  const scoreBands = db().prepare(`
    SELECT
      CASE WHEN r.score >= 9 THEN 'Alert'
           WHEN r.score >= 7 THEN 'Lead'
           ELSE 'Brief' END AS name,
      COUNT(*) AS count
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE ${whereWindow}
    GROUP BY CASE WHEN r.score >= 9 THEN 'Alert'
                  WHEN r.score >= 7 THEN 'Lead'
                  ELSE 'Brief' END
    ORDER BY MIN(r.score) DESC
  `).all(startIso, endIso);

  const market = db().prepare(`
    SELECT s.symbol, s.name, s.price, s.change_abs, s.change_pct, s.prev_close
    FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t FROM market_snapshots
      WHERE symbol IN ('^NSEI', '^BSESN', '^NSEBANK', '^INDIAVIX')
      GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
    ORDER BY CASE s.symbol
      WHEN '^NSEI' THEN 1
      WHEN '^BSESN' THEN 2
      WHEN '^NSEBANK' THEN 3
      WHEN '^INDIAVIX' THEN 4
      ELSE 9 END
  `).all();

  return { type, date: dateYmd, start: startIso, end: endIso, market, filings: signalFilings, categories, sectors, scoreBands };
}

// ─── Radar ──────────────────────────────────────────────────────────

function parseJsonList(s) {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function filingsByRecordIds(recordIds) {
  const ids = recordIds.map(Number).filter(Number.isFinite);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db().prepare(`
    SELECT ${ALL_COLS}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.record_id IN (${placeholders}) AND e.validation_ok = 1
  `).all(...ids).map(shapeFiling);
  const byId = new Map(rows.map(row => [row.record_id, row]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

function shapeRadarItem(row) {
  const evidenceIds = parseJsonList(row.evidence_record_ids);
  const tijoriUrl = row.tijori_slug ? `https://www.tijorifinance.com/company/${encodeURIComponent(row.tijori_slug)}/` : null;
  return {
    id: row.id,
    symbol: row.symbol,
    company: row.company,
    trigger_type: row.trigger_type,
    title: row.title,
    why_now: row.why_now,
    evidence_record_ids: evidenceIds,
    evidence: filingsByRecordIds(evidenceIds),
    quality_flags: parseJsonList(row.quality_flags),
    risk_flags: parseJsonList(row.risk_flags),
    radar_score: row.radar_score,
    tijori_slug: row.tijori_slug,
    tijori_url: tijoriUrl,
    status: row.status,
    generated_at: row.generated_at,
    updated_at: row.updated_at,
    company_url: `/company/${String(row.symbol || '').toLowerCase()}/`,
    sector: row.sector,
    market_cap: row.market_cap,
  };
}

export function listRadarItems({ limit = 60, status = 'active' } = {}) {
  return db().prepare(`
    SELECT ri.*, f.sector, f.market_cap
    FROM radar_items ri
    LEFT JOIN fundamentals f ON f.symbol = ri.symbol
    WHERE ri.status = ?
    ORDER BY ri.radar_score DESC, ri.updated_at DESC
    LIMIT ?
  `).all(status, limit).map(shapeRadarItem);
}

// ─── concalls ───────────────────────────────────────────────────────

const CONCALL_COLS = `
  c.isin, c.event_time, c.symbol, c.company_name, c.sector, c.slug, c.status,
  c.recording_url, c.transcript_url, c.transcript_source, c.summary_highlight,
  e.headline, e.dek, e.the_take, e.inconsistency_flag,
  e.whats_new, e.key_quotes, e.the_brief, e.canonical_category, e.model_used
`;

function shapeConcall(row) {
  if (!row) return null;
  const datePart = String(row.event_time || '').slice(0, 10);  // YYYY-MM-DD
  const sym = row.symbol || row.slug || row.isin;
  return {
    isin:               row.isin,
    event_time:         row.event_time,
    event_date:         datePart,
    symbol:             row.symbol,
    slug:               row.slug,
    company_name:       row.company_name,
    sector:             row.sector,
    status:             row.status,
    recording_url:      row.recording_url,
    transcript_url:     row.transcript_url,
    summary_highlight:  row.summary_highlight,
    headline:           row.headline,
    dek:                row.dek,
    the_take:           row.the_take,
    inconsistency_flag: row.inconsistency_flag,
    whats_new:          parseJsonArray(row.whats_new),
    key_quotes:         parseJsonArray(row.key_quotes),
    the_brief:          row.the_brief,
    canonical_url:      `/concalls/${String(sym).toLowerCase()}/${datePart}/`,
    tijori_concall_monitor_url: 'https://www.tijoristack.ai/concall-monitor',
  };
}

/** All publishable Concall Notes (enriched + validation_ok) newest first. */
export function listConcalls({ limit = 100, withInconsistencyOnly = false } = {}) {
  const where = ['e.validation_ok = 1'];
  if (withInconsistencyOnly) where.push("e.inconsistency_flag IS NOT NULL AND e.inconsistency_flag != ''");
  return db().prepare(`
    SELECT ${CONCALL_COLS}
    FROM concalls_raw c
    JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE ${where.join(' AND ')}
    ORDER BY c.event_time DESC
    LIMIT ?
  `).all(limit).map(shapeConcall);
}

/** Single Concall Note by symbol + date (YYYY-MM-DD). */
export function getConcall(symbolOrSlug, dateYmd) {
  if (!symbolOrSlug || !dateYmd) return null;
  const row = db().prepare(`
    SELECT ${CONCALL_COLS}
    FROM concalls_raw c
    JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE (LOWER(c.symbol) = LOWER(?) OR c.slug = ?)
      AND substr(c.event_time, 1, 10) = ?
      AND e.validation_ok = 1
    LIMIT 1
  `).get(symbolOrSlug, symbolOrSlug, dateYmd);
  return shapeConcall(row);
}

/** All Concall Note (symbol, date) tuples for static-path generation. */
export function listAllConcallsForStaticPaths() {
  return db().prepare(`
    SELECT c.symbol, c.slug, c.event_time
    FROM concalls_raw c
    JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE e.validation_ok = 1
    ORDER BY c.event_time DESC
  `).all().map(r => ({
    symbol: String(r.symbol || r.slug || '').toLowerCase(),
    date:   String(r.event_time).slice(0, 10),
  })).filter(p => p.symbol);
}

/** Prior concalls for the same isin — for the story-so-far on a concall page. */
export function priorConcallsForIsin(isin, excludeEventTime, limit = 4) {
  if (!isin) return [];
  return db().prepare(`
    SELECT ${CONCALL_COLS}
    FROM concalls_raw c
    JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE c.isin = ? AND c.event_time <> ? AND e.validation_ok = 1
    ORDER BY c.event_time DESC
    LIMIT ?
  `).all(isin, excludeEventTime, limit).map(shapeConcall);
}

/** All filings for static-path generation. */
export function listAllForStaticPaths(limit = 20000) {
  return db().prepare(`
    SELECT r.record_id, r.symbol, e.headline
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(limit).map(row => ({ id: buildSlug(row.symbol, row.headline, row.record_id), record_id: row.record_id }));
}

// Market signals (Tijori dashboard cards) for /alerts/. Snapshot table; refreshed
// daily by the pipeline. Returns groups in editorial priority order.
const SIGNAL_ORDER = ['Rating Upgrades', 'Promoter Buying', 'Whales Buying'];

export function getMarketSignals() {
  let rows;
  try {
    rows = db().prepare(`
      SELECT category_label, company_name, symbol, metric_name, metric_value, sector, source_url, fetched_at
      FROM market_signals ORDER BY category_label, row_index
    `).all();
  } catch {
    return { groups: [], fetched_at: null }; // table absent (older DB) — page renders empty-state
  }
  if (!rows.length) return { groups: [], fetched_at: null };

  const byCat = new Map();
  for (const r of rows) {
    const bad = r.metric_value == null || r.metric_value === 'None%' || r.metric_value === 'null' || r.metric_value === '';
    if (!byCat.has(r.category_label)) byCat.set(r.category_label, []);
    byCat.get(r.category_label).push({
      company: r.company_name,
      symbol: r.symbol,
      metric: r.metric_name,
      value: bad ? null : r.metric_value,
      sector: r.sector,
      url: r.source_url,
    });
  }
  const rank = (c) => { const i = SIGNAL_ORDER.indexOf(c); return i === -1 ? 99 : i; };
  const groups = [...byCat.entries()]
    .map(([label, cards]) => ({
      label,
      slug: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      cards,
    }))
    .sort((a, b) => rank(a.label) - rank(b.label));
  return { groups, fetched_at: rows[0].fetched_at };
}
