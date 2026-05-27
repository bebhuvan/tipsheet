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

// Guard against pipeline-added columns the site build can't assume exist (e.g. circulars_raw
// gains pdf_tables only after pdf_extract runs). Keeps the build green regardless.
const columnPresence = new Map();
function hasColumn(table, col) {
  const key = `${table}.${col}`;
  if (columnPresence.has(key)) return columnPresence.get(key);
  let found = false;
  try { found = db().prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); } catch {}
  columnPresence.set(key, found);
  return found;
}

function shapeFiling(row) {
  if (!row) return null;
  const slug = row.slug || buildSlug(row.symbol, row.headline, row.record_id);
  const marketCap = row.market_cap == null ? null : Number(row.market_cap);
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
    market_cap:         Number.isFinite(marketCap) ? marketCap : null,
    market_cap_label:   marketCapLabel(marketCap),
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
    slug,
    canonical_url:      `/${slug}/`,
  };
}

export function marketCapLabel(marketCap) {
  const v = Number(marketCap);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 100000) return 'Mega cap';
  if (v >= 20000) return 'Large cap';
  if (v >= 5000) return 'Mid cap';
  if (v >= 1000) return 'Small cap';
  return 'Micro cap';
}

export const MARKET_CAP_TIERS = [
  { slug: 'mega-cap', label: 'Mega cap', min: 100000, max: null, dek: 'India’s largest listed companies by market value.' },
  { slug: 'large-cap', label: 'Large cap', min: 20000, max: 100000, dek: 'Large listed companies below the mega-cap tier.' },
  { slug: 'mid-cap', label: 'Mid cap', min: 5000, max: 20000, dek: 'Mid-sized listed companies where liquidity and governance vary more widely.' },
  { slug: 'small-cap', label: 'Small cap', min: 1000, max: 5000, dek: 'Smaller listed companies where filings can be more company-specific and less broadly relevant.' },
  { slug: 'micro-cap', label: 'Micro cap', min: 0, max: 1000, dek: 'The smallest listed companies in the coverage universe.' },
];

export function marketCapTierBySlug(slug) {
  return MARKET_CAP_TIERS.find(t => t.slug === slug) || null;
}

function marketCapClauseForTier(tier) {
  if (!tier) return null;
  const lowerOp = tier.min === 0 ? '>' : '>=';
  const clauses = ['f.market_cap IS NOT NULL', `f.market_cap ${lowerOp} ?`];
  const params = [tier.min];
  if (tier.max != null) {
    clauses.push('f.market_cap < ?');
    params.push(tier.max);
  }
  return { sql: `r.symbol IN (SELECT f.symbol FROM fundamentals f WHERE ${clauses.join(' AND ')})`, params };
}

export function filingEyebrow(filing, { category = true, sector = true, cap = true } = {}) {
  if (!filing) return '';
  const parts = [];
  if (category && filing.canonical_category && filing.canonical_category !== 'Other') {
    parts.push(filing.canonical_category);
  }
  if (sector && filing.sector) parts.push(filing.sector);
  if (cap && filing.market_cap_label) parts.push(filing.market_cap_label);
  return parts.join(' · ');
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
  (SELECT f.market_cap FROM fundamentals f WHERE f.symbol = r.symbol LIMIT 1) AS market_cap,
  e.headline, e.dek, e.the_number_value, e.the_number_label,
  e.whats_new, e.why_it_matters, e.what_were_watching, e.faqs, e.the_full_read,
  e.editorial_tone, e.tone_score, e.tone_confidence, e.tone_reason,
  e.key_entities, ${hasColumn('filings_enriched', 'slug') ? 'e.slug' : 'NULL AS slug'}
`;

/** All publishable filings ordered newest first, optionally filtered. */
export function listFilings({ limit = 100, scoreMin = 5, category = null, marketCap = null } = {}) {
  const where = ['r.score >= ?', 'e.validation_ok = 1'];
  const params = [scoreMin];
  if (category) { where.push('e.canonical_category = ?'); params.push(category); }
  const tier = typeof marketCap === 'string' ? marketCapTierBySlug(marketCap) : marketCap;
  const capClause = marketCapClauseForTier(tier);
  if (capClause) {
    where.push(capClause.sql);
    params.push(...capClause.params);
  }
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
  const todayYmd = currentIstYmd();
  const top = listFilings({ limit: 160 });
  const sorted = [...top].sort(compareHomepageOrder);
  const lead = sorted[0] || null;
  const secondaries = sorted.slice(1, 4);

  // Mid-tier stays feed-first for a high-frequency news homepage. Section
  // discovery happens lower down in "By section"; this area should not make
  // older stories look current just to vary categories.
  const heroIds = new Set([lead?.record_id, ...secondaries.map(f => f.record_id)].filter(Boolean));
  const remaining = sorted.filter(f => !heroIds.has(f.record_id));
  // 2 used as lead-companions + 6 in the "Also in the feed" 3×2 grid below the hero.
  const MIDTIER_TARGET = 8;
  const midtier = remaining.slice(0, MIDTIER_TARGET);

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

  const totalPublished = db().prepare(`SELECT COUNT(*) AS c FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id WHERE e.validation_ok = 1`).get().c;
  const hiScore = db().prepare(`SELECT COUNT(*) AS c FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id WHERE r.score >= 8 AND e.validation_ok = 1`).get().c;
  const totalToday = db().prepare(`
    SELECT COUNT(*) AS c
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1 AND substr(r.created_on, 1, 10) = ?
  `).get(todayYmd).c;
  const hiScoreToday = db().prepare(`
    SELECT COUNT(*) AS c
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.score >= 8 AND e.validation_ok = 1 AND substr(r.created_on, 1, 10) = ?
  `).get(todayYmd).c;

  return { lead, secondaries, leadCompanions, midtier: midtierRest, briefs, wire, dist, totalToday, totalPublished, hiScore, hiScoreToday };
}

function currentIstYmd(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function compareHomepageOrder(a, b) {
  const at = String(a?.created_on || '');
  const bt = String(b?.created_on || '');
  if (at !== bt) return at < bt ? 1 : -1;
  return (b.score || 0) - (a.score || 0);
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
  let body = {};
  try { body = JSON.parse(row.sections || '{}'); } catch {}
  // Tolerate both the legacy array shape (v2 sections[]) and the v3 object shape.
  const events    = Array.isArray(body) ? [] : (Array.isArray(body.events) ? body.events : []);
  const dayMap    = Array.isArray(body) ? [] : (Array.isArray(body.day_map) ? body.day_map : []);
  const concalls  = Array.isArray(body) ? [] : (Array.isArray(body.concalls) ? body.concalls : []);
  const mgmtFlags = Array.isArray(body) ? [] : (Array.isArray(body.mgmt_flags) ? body.mgmt_flags : []);
  const calendar  = Array.isArray(body) ? [] : (Array.isArray(body.calendar) ? body.calendar : []);
  return {
    type:           row.type,
    date:           row.date,
    headline:       row.headline,
    dek:            row.dek,
    the_take:       row.the_take,
    day_map:        dayMap,
    events,
    concalls,
    mgmt_flags:     mgmtFlags,
    calendar,
    legacy_sections: Array.isArray(body) ? body : null,  // old briefings still render
    generated_at:   row.generated_at,
    model_used:     row.model_used,
    canonical_url:  `/briefings/the-${row.type}/${row.date}/`,
    label:          row.type === 'open' ? 'The Open' : 'The Close',
  };
}

const fmtCrShort = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)} L cr`;   // ≥ 1 lakh cr
  if (v >= 1000)   return `₹${Math.round(v).toLocaleString('en-IN')} cr`;
  return `₹${v.toLocaleString('en-IN')} cr`;
};
const fmtPctSigned = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return `${v > 0 ? '+' : ''}${v}%`;
};

/** A compact 3-5 metric line for a briefing event, straight from fundamentals (no LLM numbers). */
function compactFinancials(row) {
  const out = [];
  if (row.market_cap != null)     out.push({ label: 'Mkt cap', value: fmtCrShort(row.market_cap) });
  // Only show P/E when it's a meaningful positive multiple — skip losses (≤0) and
  // absurd readings from near-zero earnings (a "10,759x P/E" reads as broken, not a fact).
  const pe = Number(row.pe);
  if (Number.isFinite(pe) && pe > 0 && pe <= 200) out.push({ label: 'P/E', value: `${pe}x` });
  if (row.pat_growth != null)     out.push({ label: 'PAT', value: fmtPctSigned(row.pat_growth) });
  else if (row.roe != null)       out.push({ label: 'ROE', value: `${row.roe}%` });
  if (row.revenue_growth != null) out.push({ label: 'Rev', value: fmtPctSigned(row.revenue_growth) });
  if (row.debt_to_equity != null) out.push({ label: 'D/E', value: `${row.debt_to_equity}x` });
  return out.filter(m => m.value).slice(0, 5);
}

/**
 * Resolve briefing events (LLM gives { filing_id, prose }) into render-ready rows:
 * accurate financials + 1-week price history come from Tipsheet's own data, never the LLM.
 * Order is preserved; events whose filing_id is missing are dropped.
 */
export function getBriefingEvents(events, { historyDays = 7 } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const ids = [...new Set(events.map(e => Number(e?.filing_id)).filter(Number.isFinite))];
  if (ids.length === 0) return [];

  const rows = db().prepare(`
    SELECT r.record_id, r.symbol, r.company, r.score,
           r.event_category_canonical AS category,
           e.headline, e.the_number_value, e.the_number_label,
           ${hasColumn('filings_enriched', 'slug') ? 'e.slug' : 'NULL AS slug'},
           f.sector, f.market_cap, f.pe, f.roe, f.debt_to_equity, f.revenue_growth, f.pat_growth
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    WHERE r.record_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  const byId = new Map(rows.map(r => [Number(r.record_id), r]));

  const histBulk = getMarketHistoryBulk(rows.map(r => r.symbol).filter(Boolean), historyDays);

  return events.map(ev => {
    const row = byId.get(Number(ev?.filing_id));
    if (!row) return null;
    const history = histBulk.get(row.symbol) || [];
    const change = history.length >= 2 && history[0].close
      ? ((history.at(-1).close - history[0].close) / Math.abs(history[0].close)) * 100
      : null;
    return {
      filing_id:     row.record_id,
      symbol:        row.symbol,
      company:       row.company,
      category:      row.category,
      sector:        row.sector,
      market_cap_label: marketCapLabel(row.market_cap),
      score:         row.score,
      prose:         String(ev?.prose || ''),
      canonical_url: `/${row.slug || buildSlug(row.symbol, row.headline, row.record_id)}/`,
      financials:    compactFinancials(row),
      history,                               // [{date, close}] chronological, for <Sparkline points>
      history_change: change,                // % over the window, for the chart caption
    };
  }).filter(Boolean);
}

/** Latest Nifty / Sensex / Bank Nifty / India VIX snapshot for the briefing market strip. */
export function getBriefingMarketStrip() {
  return db().prepare(`
    SELECT s.symbol, s.name, s.price, s.change_abs, s.change_pct, s.prev_close
    FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t FROM market_snapshots
      WHERE symbol IN ('^NSEI', '^BSESN', '^NSEBANK', '^INDIAVIX')
      GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
    ORDER BY CASE s.symbol
      WHEN '^NSEI' THEN 1 WHEN '^BSESN' THEN 2 WHEN '^NSEBANK' THEN 3 WHEN '^INDIAVIX' THEN 4 ELSE 9 END
  `).all();
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
  e.whats_new,
  ${hasColumn('concalls_enriched', 'themes') ? 'e.themes' : 'NULL AS themes'},
  ${hasColumn('concalls_enriched', 'guidance_watch') ? 'e.guidance_watch' : 'NULL AS guidance_watch'},
  ${hasColumn('concalls_enriched', 'risk_flags') ? 'e.risk_flags' : 'NULL AS risk_flags'},
  e.key_quotes, e.the_brief, e.canonical_category, e.model_used
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
    themes:             parseJsonArray(row.themes),
    guidance_watch:     parseJsonArray(row.guidance_watch),
    risk_flags:         parseJsonArray(row.risk_flags),
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
    SELECT r.record_id, r.symbol, e.headline, ${hasColumn('filings_enriched', 'slug') ? 'e.slug' : 'NULL AS slug'}
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
    ORDER BY r.created_on DESC
    LIMIT ?
  `).all(limit).map(row => ({ id: row.slug || buildSlug(row.symbol, row.headline, row.record_id), record_id: row.record_id }));
}

export function listSourceHealth() {
  if (!hasTable('source_health')) return [];
  return db().prepare(`
    SELECT source, status, started_at, completed_at, last_success_at,
           inserted_count, enriched_count, item_count, latest_source_time,
           error, meta_json
    FROM source_health
    ORDER BY source
  `).all().map(row => ({
    ...row,
    meta: parseJsonObject(row.meta_json),
  }));
}

export function getFreshnessSummary() {
  const health = listSourceHealth();
  const latestFiling = db().prepare(`
    SELECT MAX(r.created_on) AS created_on, MAX(e.enriched_at) AS enriched_at
    FROM filings_raw r
    LEFT JOIN filings_enriched e ON e.record_id = r.record_id AND e.validation_ok = 1
  `).get();
  const counts = db().prepare(`
    SELECT
      (SELECT COUNT(*) FROM filings_raw) AS raw_filings,
      (SELECT COUNT(*) FROM filings_enriched WHERE validation_ok = 1) AS enriched_filings,
      (SELECT COUNT(*) FROM briefings WHERE validation_ok = 1) AS briefings
  `).get();
  return {
    generated_at: new Date().toISOString(),
    latest_filing_created_on: latestFiling?.created_on || null,
    latest_enriched_at: latestFiling?.enriched_at || null,
    counts,
    sources: health,
  };
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

// ─── Regulation + Economy (circulars_enriched + rbi_enriched) ────────
// New content streams: SEBI/NSE/BSE circulars and RBI. Routed by section:
//   /regulation = all circulars + RBI {Monetary Policy, Banking Regulation, Enforcement}
//   /economy    = RBI {Macro Data, Report}
// hasTable() guards keep the site build green even before the pipeline has created the tables.

function _slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }
function _shortHash(s) { let h = 5381; const str = String(s || ''); for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 8); }
function _ts(rfc822) { const t = Date.parse(String(rfc822 || '')); return Number.isFinite(t) ? t : 0; }
function _dateLabel(rfc822) {
  const d = new Date(_ts(rfc822));
  if (!_ts(rfc822)) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(d.getUTCDate()).padStart(2,'0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function shapeCircularNote(row) {
  const slug = `${_slugify(row.headline)}-${row.circular_id}`;
  return {
    kind: 'circular', id: row.circular_id, section: 'regulation',
    headline: row.headline, dek: row.dek,
    what_changed: parseJsonArray(row.what_changed),
    who_is_affected: row.who_is_affected, effective_date: row.effective_date,
    the_read: row.the_read, category_label: row.reg_category, severity: row.severity,
    key_entities: parseJsonArray(row.key_entities),
    source: String(row.source || '').toUpperCase(),
    stocks: parseJsonArray(row.stocks), source_url: row.pdf_url,
    tables: parseJsonArray(row.pdf_tables),
    pub_date: row.pub_date, ts: _ts(row.pub_date), date_label: _dateLabel(row.pub_date),
    slug, canonical_url: `/regulation/${slug}/`,
  };
}

function shapeRbiNote(row) {
  const section = row.section === 'economy' ? 'economy' : 'regulation';
  const slug = `${_slugify(row.headline)}-${_shortHash(row.link)}`;
  return {
    kind: 'rbi', id: row.link, section,
    headline: row.headline, dek: row.dek,
    what_changed: parseJsonArray(row.what_changed),
    the_read: row.the_read, category_label: row.category,
    key_numbers: parseJsonArray(row.key_numbers),
    source: 'RBI', source_url: row.link,
    pub_date: row.pub_date, ts: _ts(row.pub_date), date_label: _dateLabel(row.pub_date),
    slug, canonical_url: `/${section}/${slug}/`,
  };
}

// Collapse the same event arriving as multiple circulars (e.g. a Central Bank OFS = 4 procedural
// circulars; an ITC F&O adjustment filed on both NSE and BSE). Conservative key: first affected
// ticker + category + calendar day — distinct stories for one company on one day in one category
// are rare. Notes with no ticker (SEBI policy, RBI) key by id, so they never collapse. Keep the
// richest (longest the_read).
function dedupeNotes(notes) {
  const best = new Map();
  for (const n of notes) {
    const firstStock = (n.kind === 'circular' && n.stocks?.length) ? n.stocks[0] : null;
    const day = n.ts ? new Date(n.ts).toISOString().slice(0, 10) : '';
    const key = firstStock ? `${firstStock}|${n.category_label}|${day}` : `id:${n.id}`;
    const cur = best.get(key);
    if (!cur || (n.the_read?.length || 0) > (cur.the_read?.length || 0)) best.set(key, n);
  }
  return [...best.values()];
}

/** Regulation feed: all published circulars + RBI regulation notes, deduped, newest first. */
export function listRegulation({ limit = 200 } = {}) {
  const out = [];
  if (hasTable('circulars_enriched')) {
    const pdfTablesCol = hasColumn('circulars_raw', 'pdf_tables') ? 'cr.pdf_tables' : "'[]' AS pdf_tables";
    out.push(...db().prepare(`
      SELECT ce.*, cr.source, cr.pub_date, cr.stocks, cr.pdf_url, ${pdfTablesCol}
      FROM circulars_enriched ce JOIN circulars_raw cr ON cr.circular_id = ce.circular_id
      WHERE ce.validation_ok = 1 ORDER BY ce.enriched_at DESC LIMIT ?
    `).all(limit).map(shapeCircularNote));
  }
  if (hasTable('rbi_enriched')) {
    out.push(...db().prepare(`
      SELECT re.*, rr.pub_date FROM rbi_enriched re JOIN rbi_raw rr ON rr.link = re.link
      WHERE re.validation_ok = 1 AND re.section = 'regulation' ORDER BY re.enriched_at DESC LIMIT ?
    `).all(limit).map(shapeRbiNote));
  }
  return dedupeNotes(out).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function shapeMacroNote(row) {
  const slug = `${_slugify(row.headline)}-${_shortHash(row.id)}`;
  return {
    kind: 'macro', id: row.id, section: 'economy',
    headline: row.headline, dek: row.dek,
    the_read: row.the_read, category_label: row.category || 'Macro Data',
    key_numbers: parseJsonArray(row.key_numbers),
    source: 'India Data Hub', source_url: null,
    pub_date: row.release_date, ts: _ts(row.release_date), date_label: _dateLabel(row.release_date),
    slug, canonical_url: `/economy/${slug}/`,
  };
}

/** Economy feed: RBI macro-data + reports + macro data-release notes, newest first. */
export function listEconomy({ limit = 200 } = {}) {
  const out = [];
  if (hasTable('rbi_enriched')) {
    out.push(...db().prepare(`
      SELECT re.*, rr.pub_date FROM rbi_enriched re JOIN rbi_raw rr ON rr.link = re.link
      WHERE re.validation_ok = 1 AND re.section = 'economy' ORDER BY re.enriched_at DESC LIMIT ?
    `).all(limit).map(shapeRbiNote));
  }
  if (hasTable('macro_enriched')) {
    out.push(...db().prepare(`
      SELECT * FROM macro_enriched WHERE validation_ok = 1 ORDER BY enriched_at DESC LIMIT ?
    `).all(limit).map(shapeMacroNote));
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ─── Concall notes (AlphaStreet transcripts → DeepSeek summaries) ────
function shapeConcallNote(row) {
  const q = String(row.quarter || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const slug = `${_slugify(row.company)}${q ? '-' + q : ''}-${_shortHash(row.link)}`;
  return {
    ticker: row.ticker, company: row.company, quarter: row.quarter,
    headline: row.headline, the_take: row.the_take,
    whats_new: parseJsonArray(row.whats_new),
    key_quotes: parseJsonArray(row.key_quotes),
    the_brief: row.the_brief,
    guidance_signal: row.guidance_signal, sentiment: row.sentiment,
    source_url: row.link,
    pub_date: row.pub_date, ts: _ts(row.pub_date), date_label: _dateLabel(row.pub_date),
    slug, canonical_url: `/concalls/transcript/${slug}/`,
  };
}

/** Concall Notes summarised from AlphaStreet transcripts, newest first. */
export function listConcallNotes({ limit = 200 } = {}) {
  if (!hasTable('alphastreet_enriched')) return [];
  return db().prepare(`
    SELECT * FROM alphastreet_enriched WHERE validation_ok = 1 ORDER BY enriched_at DESC LIMIT ?
  `).all(limit).map(shapeConcallNote);
}
