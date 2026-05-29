// Circulars poller — READ-ONLY PROTOTYPE (no enrichment, no publishing).
//
// Source: exchangecirculars.com, a colleague-run site that already fetches NSE/BSE/SEBI
// circulars, parses the (often nested/zipped) PDFs, runs an LLM over them, and republishes
// the result as a clean RSS feed at /feed.xml. Because the heavy lifting (PDF parsing +
// summarisation + impact classification) is done upstream, we do NOT touch PDFs here — we
// consume the structured feed and decide what is editorially relevant.
//
// What this script does:
//   1. Fetch feed.xml (public; no secret, unlike the Tijori URL).
//   2. Parse each <item> — including the circular:* extension fields.
//   3. Run a deterministic RELEVANCE GATE (importance threshold + topic allowlist).
//      ~80-90% of circulars are routine noise; the gate is how we avoid spending a single
//      LLM token on them. Filtering is a WHERE clause, not a model.
//   4. Persist EVERY item to circulars_raw with its gate verdict (passed_gate + reasons),
//      so we can eyeball both survivors and near-misses and tune the allowlist over days.
//
// Re-running is idempotent and re-classifies existing rows (ON CONFLICT DO UPDATE), so you
// can edit the allowlist below, re-run, and watch the survivor set change.
//
// Run:  node pipeline/circulars_poller.mjs            (poll, classify, store, print summary)
//       node pipeline/circulars_poller.mjs --rejects  (also list near-miss rejects, for tuning)

import Database from 'better-sqlite3';
import { withHealth } from './db.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
const FEED_BASE = process.env.CIRCULARS_FEED_BASE || 'https://exchangecirculars.com';
// Poll the PER-SOURCE feeds, not the firehose feed.xml: the main feed is NSE/BSE-dominated
// and SEBI circulars (the highest editorial value) barely appear in it. Each feed returns the
// ~50 most recent for that source. Feed pagination is not supported (?page is ignored), so
// history is built by polling repeatedly over time, not by paging.
const SOURCE_FEEDS = {
  nse:  `${FEED_BASE}/circulars/nse/feed.xml`,
  bse:  `${FEED_BASE}/circulars/bse/feed.xml`,
  sebi: `${FEED_BASE}/circulars/sebi/feed.xml`,
};
const UA = 'Filings/circulars-poller (https://filings.in)';

// ─── relevance gate (SOURCE-AWARE) ──────────────────────────────────
// Two regimes, because the upstream classifier behaves very differently per source:
//
//   NSE / BSE — importance is reasonably calibrated. PASS = importance:high OR a topic-group
//   match, MINUS operational/debt/MF noise vetoes.
//
//   SEBI — importance is MIScalibrated (the Religare insider-trading final order, the Bajaj
//   Hindusthan fund-diversion order, etc. are all tagged "low"). So we IGNORE importance for
//   SEBI and use title patterns: a substantive-order/policy allowlist, minus a heavy veto for
//   the procedural chaff (recovery certificates, notices of demand, attachments, RTI appeals)
//   and the bulk "illiquid stock options" adjudications SEBI mass-issues against shell entities.
//
// Tune freely: edit the lists, re-run — existing rows get re-classified (ON CONFLICT UPDATE).

// NSE/BSE topic groups (matched against title + category + tags).
const TOPIC_GROUPS = {
  // ASM/GSM/ESM surveillance rosters + price-band lists are dropped (vetoed below) — they're
  // data, not articles. What stays here are genuine distress signals worth an editorial read.
  distress:       ['insolvency', 'bankruptcy', 'encumbrance', 'sast'],
  market_maker:   ['market-maker', 'market maker', 'market-making', 'market making', 'liquidity-provider'],
  derivatives:    ['contract-adjustment', 'contract adjustment', 'f&o contract', 'fno contract',
                   'lot-size', 'lot size', 'market-lot', 'revised-market-lot',
                   'exclusion of futures', 'corporate-action-adjustment'],
  corp_action:    ['dividend', 'bonus', 'stock-split', 'stock split', 'face value split', 'face-value-split',
                   ' split ', 'rights-issue', 'rights issue', 'buyback', 'buy-back', 'demerger',
                   'scheme-of-arrangement', 'takeover', 'open offer', 'open-offer', 'offer-to-buy',
                   'offer for sale', 'offer-for-sale'],
  index_change:   ['reconstitution', 'index review', 'index inclusion', 'index exclusion', 'f&o ban'],
  listing_status: ['delisting', 'de-listing', 'voluntary-delisting', 'compulsory-delisting',
                   'dissemination board', 'forfeiture'],
};
const GROUP_NAMES = Object.keys(TOPIC_GROUPS);

// NSE/BSE vetoes (title) — operational + debt/MF mechanics. Per the 2026-05-24 decision we
// drop ALL debt-instrument trading suspensions (debentures/CP/NCD/PTC) and MF plumbing.
const EXCHANGE_VETO = [
  'mock trading', 'mock session', 'mock test', 'trial session', 'demat auction',
  'debenture', 'commercial paper', ' ncd', ' ncds', 'partly paid', ' ptc', ' ptcs', ' fmp ',
  'mutual fund', ' sip ', ' stp ', 'fund of fund', 'fund-of-fund',
  // ASM/GSM/ESM surveillance rosters + price-band lists — dropped for now (data, not articles).
  'additional surveillance', 'enhanced surveillance', 'graded surveillance', 'gsm stage',
  'st-asm', 'lt-asm', 'short-term additional', 'long term additional',
  'changes in price band', 'price band for', 'price-band',
];

// SEBI veto (title) — procedural/recovery chaff + bulk illiquid-options adjudications.
const SEBI_VETO = [
  'recovery certificate', 'notice of demand', 'attachment proceeding', 'attachment of bank',
  'release order', 'remittance order', 'rti appeal', 'completion of recovery', 'cancellation of recovery',
  'illiquid stock options', 'a.p no', 'a.p. no', 'certificate no. rc', 'rc no.', 'rc9', 'rc8',
];
// SEBI substantive allowlist (title) — real orders + policy circulars worth an editorial read.
const SEBI_PASS = [
  'adjudication order', 'final order', 'interim order', 'settlement order', 'order in the matter',
  'insider trading', 'price manipulation', 'front running', 'front-running', 'fund diversion',
  'misutilis', 'misappropriat', 'unregistered', 'prohibitory order', 'debar', 'ban order',
  'telegram', 'whatsapp', 'social media',
  // policy / framework
  'review of', 'framework', 'guidelines', 'master circular', 'amendment', 'norms',
  'disclosure requirement', 'eligibility', 'consultation paper', 'permitted use',
];

function classifySebi(title) {
  if (SEBI_VETO.some(kw => title.includes(kw))) return { passed: false, reasons: ['vetoed:sebi-procedural'] };
  const hits = SEBI_PASS.filter(kw => title.includes(kw));
  return { passed: hits.length > 0, reasons: hits.length ? ['sebi:' + hits[0]] : [] };
}

function classifyExchange(item, title) {
  if (EXCHANGE_VETO.some(kw => title.includes(kw))) return { passed: false, reasons: ['vetoed:operational'] };
  const reasons = [];
  if ((item.importance || '').toLowerCase() === 'high') reasons.push('high-importance');
  const hay = [item.title, item.category, ...(item.tags || [])].join(' ').toLowerCase();
  for (const g of GROUP_NAMES) {
    if (TOPIC_GROUPS[g].some(kw => hay.includes(kw))) reasons.push(g);
  }
  return { passed: reasons.length > 0, reasons };
}

function classify(item) {
  const title = ' ' + (item.title || '').toLowerCase() + ' ';   // pad so ' split '/' ibc ' word-ish matches fire
  return (item.source || '').toLowerCase() === 'sebi'
    ? classifySebi(title)
    : classifyExchange(item, title);
}

// ─── feed fetch + parse ─────────────────────────────────────────────
async function fetchOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/rss+xml' } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Fetch all per-source feeds, parse, and merge — dedup by circular_id (feeds can overlap).
async function fetchAllFeeds() {
  const merged = new Map();
  for (const [src, url] of Object.entries(SOURCE_FEEDS)) {
    let xml;
    try { xml = await fetchOne(url); }
    catch (e) { console.warn(`  ! ${src} feed failed: ${e.message}`); continue; }
    for (const it of parseItems(xml)) {
      it.source = it.source || src;          // trust feed's circular:source, fall back to which feed it came from
      if (!merged.has(it.circular_id)) merged.set(it.circular_id, it);
    }
  }
  return [...merged.values()];
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Lightweight, feed-specific parser. PROTOTYPE-ONLY: regex over a known, stable RSS shape.
// Production should swap to a real XML parser (e.g. fast-xml-parser) for CDATA/namespace safety.
function parseItems(xml) {
  const blocks = xml.split('<item>').slice(1).map(b => b.split('</item>')[0]);
  const one = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!m) return null;
    let v = m[1].trim();
    const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    if (cdata) v = cdata[1].trim();
    return decodeEntities(v) || null;
  };
  const many = (b, tag) => {
    const out = [];
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
    let m;
    while ((m = re.exec(b))) out.push(decodeEntities(m[1].trim()));
    return out;
  };
  // content:encoded → strip tags to a plain-text summary for eyeballing.
  const summaryOf = (b) => {
    const enc = b.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/);
    let txt = enc ? enc[1] : (one(b, 'description') || '');
    const cdata = txt.match(/<!\[CDATA\[([\s\S]*)\]\]>/);
    if (cdata) txt = cdata[1];
    // Store the full pre-digested summary — do NOT truncate. Large lists (index reconstitutions,
    // enforcement entity lists) carry the SEO-valuable stock names here; the old 2000-char cap
    // was silently dropping them. Cap high only as a runaway guard.
    return decodeEntities(txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 20000);
  };

  return blocks.map(b => ({
    circular_id: one(b, 'circular:id'),
    source:      one(b, 'circular:source'),
    title:       one(b, 'title'),
    link:        one(b, 'link'),
    pub_date:    one(b, 'pubDate'),
    category:    one(b, 'circular:category'),
    impact:      one(b, 'circular:impact'),
    severity:    one(b, 'circular:severity'),
    importance:  one(b, 'circular:importance'),
    pdf_url:     one(b, 'circular:pdfUrl'),
    stocks:      many(b, 'circular:stock'),
    tags:        many(b, 'category'),
    summary:     summaryOf(b),
    raw_xml:     b.trim(),
  })).filter(it => it.circular_id);
}

// ─── storage ────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS circulars_raw (
      circular_id  TEXT PRIMARY KEY,
      source       TEXT,
      title        TEXT,
      link         TEXT,
      pub_date     TEXT,
      category     TEXT,
      impact       TEXT,
      severity     TEXT,
      importance   TEXT,
      pdf_url      TEXT,
      stocks       TEXT,
      tags         TEXT,
      summary      TEXT,
      passed_gate  INTEGER,
      gate_reasons TEXT,
      raw_xml      TEXT,
      fetched_at   INTEGER
    )`,
  `CREATE INDEX IF NOT EXISTS idx_circ_passed ON circulars_raw(passed_gate, pub_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_circ_source ON circulars_raw(source)`,
];

function openDb() {
  const path = process.env.DB_PATH || DEFAULT_DB;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  for (const stmt of SCHEMA) db.prepare(stmt).run();
  // Ensure the PDF-extract columns exist even before pdf_extract.py has run, so the site's
  // listRegulation query (which selects pdf_tables) never hits a missing column in CI.
  const cols = db.prepare('PRAGMA table_info(circulars_raw)').all().map(r => r.name);
  for (const [c, t] of [['pdf_text', 'TEXT'], ['pdf_tables', 'TEXT'], ['pdf_extracted_at', 'INTEGER']]) {
    if (!cols.includes(c)) db.prepare(`ALTER TABLE circulars_raw ADD COLUMN ${c} ${t}`).run();
  }
  return db;
}

const upsertStmt = (db) => db.prepare(`
  INSERT INTO circulars_raw
    (circular_id, source, title, link, pub_date, category, impact, severity, importance,
     pdf_url, stocks, tags, summary, passed_gate, gate_reasons, raw_xml, fetched_at)
  VALUES
    (@circular_id, @source, @title, @link, @pub_date, @category, @impact, @severity, @importance,
     @pdf_url, @stocks, @tags, @summary, @passed_gate, @gate_reasons, @raw_xml, @fetched_at)
  ON CONFLICT(circular_id) DO UPDATE SET
    passed_gate  = excluded.passed_gate,
    gate_reasons = excluded.gate_reasons,
    importance   = excluded.importance,
    fetched_at   = excluded.fetched_at
`);

// ─── main ───────────────────────────────────────────────────────────
async function main() {
  const showRejects = process.argv.includes('--rejects');
  const items = await fetchAllFeeds();
  const db = openDb();
  const stmt = upsertStmt(db);

  let newCount = 0;
  const survivors = [];
  const nearMiss = [];
  const now = Date.now();
  const existing = new Set(db.prepare('SELECT circular_id FROM circulars_raw').all().map(r => r.circular_id));

  for (const it of items) {
    const { passed, reasons } = classify(it);
    if (!existing.has(it.circular_id)) newCount++;
    stmt.run({
      ...it,
      stocks: JSON.stringify(it.stocks),
      tags: JSON.stringify(it.tags),
      passed_gate: passed ? 1 : 0,
      gate_reasons: JSON.stringify(reasons),
      fetched_at: now,
    });
    if (passed) survivors.push({ ...it, reasons });
    else if ((it.importance || '').toLowerCase() === 'medium') nearMiss.push(it);
  }

  // Stored totals (across all polls so far), not just this fetch.
  const totals = db.prepare('SELECT passed_gate, COUNT(*) n FROM circulars_raw GROUP BY passed_gate').all();
  const totalStored = totals.reduce((a, r) => a + r.n, 0);
  const totalPassed = totals.find(r => r.passed_gate === 1)?.n || 0;

  console.log(`\n  feed: ${items.length} items this fetch · ${newCount} new · stored total ${totalStored}`);
  console.log(`  gate: ${survivors.length}/${items.length} passed this fetch · ${totalPassed}/${totalStored} passed all-time\n`);

  console.log('  ── SURVIVORS (would become regulatory notes) ──');
  if (!survivors.length) console.log('  (none this fetch)');
  for (const s of survivors) {
    const date = (s.pub_date || '').replace(/ \d{2}:\d{2}.*$/, '');
    const stk = s.stocks.length ? ` [${s.stocks.slice(0, 4).join(',')}${s.stocks.length > 4 ? `+${s.stocks.length - 4}` : ''}]` : '';
    console.log(`  • ${(s.source || '?').toUpperCase().padEnd(4)} ${(s.importance || '?').padEnd(6)} ${date}  ${s.title}`);
    console.log(`        reasons: ${s.reasons.join(', ')}${stk}`);
  }

  if (showRejects) {
    console.log('\n  ── NEAR-MISS REJECTS (medium importance, no topic match — tuning candidates) ──');
    if (!nearMiss.length) console.log('  (none this fetch)');
    for (const r of nearMiss) {
      console.log(`  · ${(r.source || '?').toUpperCase().padEnd(4)} ${r.title}`);
      console.log(`        tags: ${(r.tags || []).slice(0, 8).join(', ')}`);
    }
  }

  console.log(`\n  Re-run anytime (idempotent). Tune TOPIC_GROUPS in this file and re-run to re-classify.`);
  console.log(`  Inspect stored rows with a SELECT on circulars_raw WHERE passed_gate=1.\n`);
  db.close();
}

withHealth('circulars_poll', main).catch(e => { console.error('circulars-poller failed:', e.message); process.exit(1); });
