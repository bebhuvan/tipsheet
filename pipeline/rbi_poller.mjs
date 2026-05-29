// RBI poller — READ-ONLY PROTOTYPE (no enrichment, no publishing).
//
// Polls RBI's official RSS feeds (notifications / press releases / publications) and runs a
// relevance gate, same approach we used for exchangecirculars. One daily-evening poll catches:
//   - RBI circulars/notifications (banking & prudential regulation)
//   - press releases (incl. RBI's own recurring DATA: forex reserves / WSS, lending rates, trade)
//   - the monthly RBI Bulletin + reports (flagged kind='report' → routed to the PDF→DeepSeek flow)
//
// RBI publishes throughout the day with an evening cluster (~17:00-19:30 IST), so an evening
// cron picks up the day's output. Idempotent: dedup by guid/link, re-running re-classifies.
//
// Run:  node pipeline/rbi_poller.mjs            (poll, classify, store, print)
//       node pipeline/rbi_poller.mjs --rejects  (also list rejects)

import Database from 'better-sqlite3';
import { withHealth } from './db.mjs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
const BASE = process.env.RBI_FEED_BASE || 'https://www.rbi.org.in';
const FEEDS = {
  notification: `${BASE}/notifications_rss.xml`,
  pressrelease: `${BASE}/pressreleases_rss.xml`,
  publication:  `${BASE}/Publication_rss.xml`,
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── relevance gate ─────────────────────────────────────────────────
// RBI is mostly banking plumbing; like SEBI we filter hard. Keep what moves markets or matters
// to bank/NBFC/equity investors; veto routine high-volume auctions/redemptions/admin.
const TOPIC_GROUPS = {
  monetary:     ['monetary policy', 'repo rate', 'policy rate', ' mpc', 'liquidity', ' crr', ' slr',
                 'open market operation', ' omo', 'standing deposit', 'cash reserve'],
  prudential:   ['prudential', 'capital adequacy', 'basel', 'provisioning', 'asset classification',
                 'priority sector', 'exposure', 'digital lending', 'co-lending', ' lcr', 'risk weight',
                 'unsecured', 'gold loan', 'project finance', 'expected credit loss', ' ecl'],
  enforcement:  ['penalty', 'penalis', 'imposes', 'monetary penalty', 'fraud', 'cancels the licence',
                 'cancellation of licence', 'cancellation of certificate', 'prohibit', 'directions against'],
  structure:    ['amalgamation', 'merger', 'licence', 'licensing', 'small finance bank', 'payments bank',
                 'nbfc', 'banking licence', 'universal bank', 'wilful defaulter'],
  rbi_data:     ['foreign exchange reserves', 'weekly statistical supplement', 'forex reserves',
                 'lending and deposit rates', 'international trade', 'money supply', 'bank credit',
                 'sectoral deployment'],
};
const GROUP_NAMES = Object.keys(TOPIC_GROUPS);

// Reports/Bulletin → not a "circular" note; route to the PDF→articles flow.
const REPORT_HINTS = ['bulletin', 'financial stability report', 'monetary policy report',
  'report on', 'survey', 'monetary and credit information', 'handbook of statistics', 'annual report'];

// Routine high-volume noise — never publish.
const VETO = ['auction', 't-bill', 'treasury bill', 'state government securities', 'state development loan',
  'sovereign gold bond', ' sgb', 'redemption price', 'tender', 'vacancy', 'recruitment', 'draw of lots',
  'premature redemption', 'result of', 'sale (re-issue)', 'conversion/switch'];

function classify(item) {
  const title = ' ' + (item.title || '').toLowerCase() + ' ';
  if (VETO.some(kw => title.includes(kw))) return { kind: 'circular', passed: false, reasons: ['vetoed:routine'] };
  if (REPORT_HINTS.some(kw => title.includes(kw))) return { kind: 'report', passed: true, reasons: ['report'] };
  const reasons = [];
  for (const g of GROUP_NAMES) if (TOPIC_GROUPS[g].some(kw => title.includes(kw))) reasons.push(g);
  return { kind: 'circular', passed: reasons.length > 0, reasons };
}

// ─── fetch + parse ──────────────────────────────────────────────────
async function fetchOne(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    // RBI 406s a narrow Accept header; send a browser-style Accept.
    const r = await fetch(url, { signal: ctrl.signal, headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

function decode(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#8377;/g, '₹').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

function parseItems(xml, feedKind) {
  const blocks = xml.split('<item>').slice(1).map(b => b.split('</item>')[0]);
  const one = (b, tag) => { const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]) : null; };
  return blocks.map(b => ({
    feed: feedKind,
    title: one(b, 'title'),
    link: one(b, 'link') || one(b, 'guid'),
    pub_date: one(b, 'pubDate'),
    summary: one(b, 'description') || '',
  })).filter(it => it.title && it.link);
}

async function fetchAll() {
  const merged = new Map();
  for (const [kind, url] of Object.entries(FEEDS)) {
    let xml; try { xml = await fetchOne(url); } catch (e) { console.warn(`  ! ${kind} feed failed: ${e.message}`); continue; }
    for (const it of parseItems(xml, kind)) if (!merged.has(it.link)) merged.set(it.link, it);
  }
  return [...merged.values()];
}

// ─── storage ────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rbi_raw (
     link TEXT PRIMARY KEY, feed TEXT, title TEXT, pub_date TEXT, summary TEXT,
     kind TEXT, passed_gate INTEGER, gate_reasons TEXT, fetched_at INTEGER )`,
  `CREATE INDEX IF NOT EXISTS idx_rbi_passed ON rbi_raw(passed_gate, pub_date DESC)`,
];
function openDb() {
  const path = process.env.DB_PATH || DEFAULT_DB;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  for (const s of SCHEMA) db.prepare(s).run();
  return db;
}
const upsert = (db) => db.prepare(`
  INSERT INTO rbi_raw (link, feed, title, pub_date, summary, kind, passed_gate, gate_reasons, fetched_at)
  VALUES (@link, @feed, @title, @pub_date, @summary, @kind, @passed_gate, @gate_reasons, @fetched_at)
  ON CONFLICT(link) DO UPDATE SET kind=excluded.kind, passed_gate=excluded.passed_gate,
    gate_reasons=excluded.gate_reasons, fetched_at=excluded.fetched_at`);

async function main() {
  const showRejects = process.argv.includes('--rejects');
  const items = await fetchAll();
  const db = openDb();
  const stmt = upsert(db);
  const now = Date.now();
  const existing = new Set(db.prepare('SELECT link FROM rbi_raw').all().map(r => r.link));
  let neu = 0; const survivors = [], reports = [], rejects = [];
  for (const it of items) {
    const { kind, passed, reasons } = classify(it);
    if (!existing.has(it.link)) neu++;
    stmt.run({ ...it, kind, passed_gate: passed ? 1 : 0, gate_reasons: JSON.stringify(reasons), fetched_at: now });
    if (kind === 'report' && passed) reports.push({ ...it, reasons });
    else if (passed) survivors.push({ ...it, reasons });
    else rejects.push(it);
  }
  console.log(`\n  RBI feeds: ${items.length} items · ${neu} new`);
  console.log(`  gate: ${survivors.length} circular-notes · ${reports.length} reports(PDF flow) · ${rejects.length} rejected\n`);
  console.log('  ── CIRCULAR NOTES (would publish) ──');
  for (const s of survivors) console.log(`  • [${s.feed}] ${(s.pub_date||'').replace(/ \d\d:.*/,'')}  ${s.title}\n        ${s.reasons.join(', ')}`);
  console.log('\n  ── REPORTS → PDF→DeepSeek multi-article flow ──');
  for (const r of reports) console.log(`  • ${r.title}`);
  if (showRejects) { console.log('\n  ── REJECTED ──'); for (const r of rejects.slice(0, 30)) console.log(`  · ${r.title}`); }
  console.log('');
  db.close();
}
withHealth('rbi_poll', main).catch(e => { console.error('rbi-poller failed:', e.message); process.exit(1); });
