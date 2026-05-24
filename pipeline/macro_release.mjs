// Macro data-release engine — turns India Data Hub released indicators into /economy data notes.
//
// The recurring-SEO engine: every CPI/IIP/GST/trade/FX-reserves print is a heavily-searched,
// predictable event. We re-fetch IDH's calendar for a trailing window (actuals fill in after
// release), keep the high-value headline indicators, and summarise each into a short data note.
// The NUMBERS come from IDH (deterministic); DeepSeek writes only the prose around them.
//
// Run:  node --env-file=../.env macro_release.mjs run [N]    (poll trailing window + enrich)
//       node --env-file=../.env macro_release.mjs test [N]

import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES } from './banned-patterns.mjs';
import { chatJson, DEEPSEEK_MODEL } from './deepseek.mjs';
import { fetchCalendar, flattenCalendarEvent } from './idh_poller.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
export const MACRO_PROMPT_VERSION = 'macro-note.v1';

// Headline indicators only — skip the micro-series IDH also carries.
const MACRO_ALLOW = [
  'consumer price', 'cpi', 'wholesale price', 'wpi', 'industrial production', ' iip',
  'gst collection', 'merchandise trade', 'merchandise export', 'merchandise import', 'trade balance',
  'fx reserves', 'foreign exchange reserves', 'gdp', 'gross domestic', 'gva', 'repo rate',
  'core', 'infrastructure output', 'eight core', 'bank credit', 'portfolio net equity',
  'portfolio net debt', 'current account', 'fiscal deficit', 'unemployment', 'pmi', 'e-way bill',
];
const isAllowed = (ind) => { const s = (ind || '').toLowerCase(); return MACRO_ALLOW.some(k => s.includes(k)); };

// ─── poll: refresh a trailing window so actuals fill in ─────────────
function openDb() {
  const db = new Database(process.env.DB_PATH || DEFAULT_DB);
  db.pragma('journal_mode = WAL');
  db.prepare(`CREATE TABLE IF NOT EXISTS macro_calendar (
     date TEXT NOT NULL, identifier TEXT, country_code TEXT, coverage TEXT, indicator TEXT NOT NULL,
     period TEXT, previous_val REAL, forecast_val REAL, actual_val REAL, category TEXT, unit TEXT,
     frequency TEXT, impact TEXT, date_type TEXT, event_flag INTEGER DEFAULT 0, raw_json TEXT,
     fetched_at INTEGER NOT NULL, PRIMARY KEY (date, identifier, country_code))`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS macro_enriched (
     id TEXT PRIMARY KEY, indicator TEXT, period TEXT, release_date TEXT,
     actual TEXT, forecast TEXT, previous TEXT, unit TEXT,
     headline TEXT, dek TEXT, the_read TEXT, key_numbers TEXT, category TEXT,
     model_used TEXT, prompt_version TEXT, enriched_at INTEGER, validation_ok INTEGER, validation_issues TEXT)`).run();
  return db;
}

export async function pollReleases({ days = 21 } = {}) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const to = new Date(), from = new Date(Date.now() - days * 864e5);
  const { events } = await fetchCalendar({ from_date: fmt(from), to_date: fmt(to), country_code: 'IN', per_page: 100 });
  const db = openDb();
  const ins = db.prepare(`INSERT OR REPLACE INTO macro_calendar
    (date, identifier, country_code, coverage, indicator, period, previous_val, forecast_val, actual_val,
     category, unit, frequency, impact, date_type, event_flag, raw_json, fetched_at)
    VALUES (@date,@identifier,@country_code,@coverage,@indicator,@period,@previous_val,@forecast_val,
     @actual_val,@category,@unit,@frequency,@impact,@date_type,@event_flag,@raw_json,@fetched_at)`);
  let n = 0;
  for (const ev of events) { const f = flattenCalendarEvent(ev); if (f) { ins.run({ ...f, fetched_at: Date.now() }); n++; } }
  db.close();
  return { fetched: events.length, upserted: n };
}

// ─── enrich one release ─────────────────────────────────────────────
const SYSTEM = `You are a markets editor for Tipsheet writing a one-paragraph data note on an Indian macro release. You are given the indicator, period, and its actual / forecast / previous values. Those numbers are your ONLY source — use them exactly, do not invent any other figure, percentage, or cause.

VOICE: FT Lex / Buttonwood. Sentence case, active voice, varied sentence length, one idea per sentence. Lead with the print and its direction vs the prior (and vs forecast if given). The_read says what the number signals, strictly from the comparison — no invented drivers, no "due to", no market reaction.

BANNED: underscores/highlights/emphasizes; "not just X but Y"; moreover/furthermore; significant/robust/crucial; in conclusion/overall; announces; opening adverbs; rhetorical questions. Bold the numbers in the_read. End on the verdict.

Return ONLY JSON:
{
 "headline": "<=90 chars, the indicator + its move (e.g. 'India's IIP slows to 2.3% in March from 2.2%')",
 "dek": "<=180 chars, the bottom line",
 "the_read": "50-110 words. The print vs prior/forecast and what it signals. Bold the numbers. No invented causes. End on the verdict.",
 "key_numbers": ["2-4 'label: value' strings using only the given actual/forecast/previous"]
}`;

function buildFeedback(v) {
  const lines = ['Rewrite the ENTIRE JSON fixing these, same schema:'];
  if (v.banned?.length) lines.push(`- Banned: ${v.banned.map(b => `"${b}"`).join(', ')}.`);
  if (v.fabricated?.length) lines.push(`- Numbers not in the source: ${v.fabricated.join(', ')}. Use ONLY the given actual/forecast/previous.`);
  if (v.structural?.includes('monotone_sentence_lengths')) lines.push('- Vary sentence length in the_read.');
  if (v.issues?.includes('the_read_thin')) lines.push('- the_read must be 50-110 words.');
  return lines.join('\n');
}

function numberFingerprint(text) {
  const out = new Set();
  for (const m of String(text || '').match(/\d[\d,.]*/g) || []) { const n = m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, ''); if (n) out.add(n); }
  return out;
}

function validate(p, srcNums) {
  const issues = [];
  if (!p.headline || p.headline.length > 95) issues.push('headline');
  if (!p.the_read || p.the_read.length < 120) issues.push('the_read_thin');
  const prose = [p.headline, p.dek, p.the_read, ...(p.key_numbers || [])].filter(Boolean).join(' ');
  const banned = []; for (const re of PHRASE_PATTERNS) { const m = prose.match(re); if (m) banned.push(m[0]); }
  if (banned.length) issues.push(`banned:${banned.slice(0, 4).join('|')}`);
  const structural = []; for (const r of STRUCTURAL_RULES) { const h = r(prose, { full_read: p.the_read }); if (h) structural.push(h.name); }
  if (structural.length) issues.push(`structural:${structural.join('|')}`);
  // number fidelity: every >=3-char number in output must be in the source values
  const out = numberFingerprint(prose);
  const fabricated = [...out].filter(n => n.length >= 3 && ![...srcNums].some(s => s.startsWith(n) || n.startsWith(s)));
  if (fabricated.length) issues.push('fabricated');
  return { ok: issues.length === 0, issues, banned, structural, fabricated };
}

export async function enrichRelease(row, prev = null) {
  const user = `Indicator: ${row.indicator}\nPeriod: ${row.period || '—'}\nUnit: ${row.unit || ''}\n`
    + `Actual: ${row.actual_val}\nForecast: ${row.forecast_val ?? 'not given'}\nPrevious: ${row.previous_val ?? 'not given'}`;
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  if (prev?.parsed && prev?.validation?.issues?.length) {
    messages.push({ role: 'assistant', content: JSON.stringify(prev.parsed) });
    messages.push({ role: 'user', content: buildFeedback(prev.validation) });
  }
  const res = await chatJson({ messages, temperature: 0.3, maxTokens: 900 });
  if (!res.parsed) return { ok: false, error: res.error };
  const srcNums = numberFingerprint(`${row.actual_val} ${row.forecast_val} ${row.previous_val} ${row.period}`);
  const v = validate(res.parsed, srcNums);
  return { ok: v.ok, parsed: res.parsed, validation: v, usage: res.usage, elapsed_ms: res.elapsed_ms };
}

async function enrichWithRetry(row, max = 3) {
  let r = await enrichRelease(row); let tries = 1;
  while (!r.ok && r.validation?.issues?.length && tries < max) { r = await enrichRelease(row, r); tries++; }
  return { ...r, tries };
}

// ─── select released indicators (allowed, deduped) ──────────────────
function pendingReleases(db, limit) {
  const cutoff = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM macro_calendar
     WHERE country_code='IN' AND actual_val IS NOT NULL AND date >= ?
       AND impact IN ('H','M') ORDER BY date DESC`).all(cutoff);
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (!isAllowed(r.indicator)) continue;
    const key = `${(r.indicator || '').toLowerCase().replace(/\s+/g, ' ').trim()}|${r.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    r.id = `${(r.indicator || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}-${r.period || r.date.slice(0, 10)}`;
    out.push(r);
  }
  return out.slice(0, limit);
}

async function runMode() {
  const limit = Number(process.argv[3] || 15);
  const poll = await pollReleases();
  console.log(`[macro] polled ${poll.fetched} IDH events`);
  const db = openDb();
  const already = new Set(db.prepare('SELECT id FROM macro_enriched').all().map(r => r.id));
  const pending = pendingReleases(db, 999).filter(r => !already.has(r.id)).slice(0, limit);
  console.log(`[macro] ${pending.length} releases to enrich`);
  const ins = db.prepare(`INSERT OR REPLACE INTO macro_enriched
    (id, indicator, period, release_date, actual, forecast, previous, unit, headline, dek, the_read,
     key_numbers, category, model_used, prompt_version, enriched_at, validation_ok, validation_issues)
    VALUES (@id,@indicator,@period,@release_date,@actual,@forecast,@previous,@unit,@headline,@dek,@the_read,
     @key_numbers,@category,@model_used,@prompt_version,@enriched_at,@validation_ok,@validation_issues)`);
  let ok = 0, held = 0, failed = 0;
  for (const row of pending) {
    const r = await enrichWithRetry(row);
    if (!r.parsed) { failed++; console.log(`  ! ${row.indicator} ${r.error}`); continue; }
    const p = r.parsed;
    ins.run({
      id: row.id, indicator: row.indicator, period: row.period || '', release_date: row.date,
      actual: String(row.actual_val), forecast: row.forecast_val == null ? '' : String(row.forecast_val),
      previous: row.previous_val == null ? '' : String(row.previous_val), unit: row.unit || '',
      headline: p.headline, dek: p.dek || '', the_read: p.the_read || '', key_numbers: JSON.stringify(p.key_numbers || []),
      category: 'Macro Data', model_used: DEEPSEEK_MODEL, prompt_version: MACRO_PROMPT_VERSION, enriched_at: Date.now(),
      validation_ok: r.ok ? 1 : 0, validation_issues: JSON.stringify(r.validation?.issues || []),
    });
    r.ok ? ok++ : held++;
  }
  console.log(`[macro] persisted ok=${ok} held-for-review=${held} failed=${failed}`);
  db.close();
}

async function testMain() {
  const n = Number(process.argv[3] || 4);
  await pollReleases();
  const db = openDb();
  const pending = pendingReleases(db, n);
  db.close();
  console.log(`DeepSeek ${DEEPSEEK_MODEL} · ${pending.length} releases\n`);
  for (const row of pending) {
    console.log('━'.repeat(80));
    console.log(`${row.indicator} (${row.period}) actual=${row.actual_val}${row.unit || ''} prev=${row.previous_val}`);
    const r = await enrichWithRetry(row);
    if (!r.parsed) { console.log('  FAILED:', r.error); continue; }
    const p = r.parsed;
    console.log(`  ok=${r.ok} tries=${r.tries}`);
    console.log(`  ${p.headline}`);
    console.log(`  ${(p.the_read || '').replace(/\*\*/g, '')}\n`);
  }
}

const _cmd = import.meta.url === pathToFileURL(process.argv[1]).href ? process.argv[2] : null;
if (_cmd === 'test') testMain().catch(e => { console.error(e); process.exit(1); });
else if (_cmd === 'run') runMode().catch(e => { console.error(e); process.exit(1); });
else if (_cmd === 'poll') pollReleases().then(r => console.log(r)).catch(e => { console.error(e); process.exit(1); });
