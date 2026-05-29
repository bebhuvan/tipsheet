// AlphaStreet concall ingest + summarise — PROTOTYPE.
//
// AlphaStreet's India transcripts RSS carries the FULL raw earnings-call transcript (~40k chars)
// with the ticker in the title, same-day. We use it for: (1) immediacy — publish a Concall Note
// the day of the call, ahead of slower aggregators; (2) the transcript itself is the company's
// primary document, so summarising it is original work. We cite the call/company, never republish
// AlphaStreet's text, and never rewrite their editorial (the feed is just discovery + raw transcript).
//
// Summarisation runs on the shared DeepSeek harness (deepseek-v4-flash) — a long-context job the
// cheap model handles well. Reuses the house anti-slop validators.
//
// Run:  node alphastreet.mjs              (poll RSS → alphastreet_raw, print)
//       node --env-file=../.env alphastreet.mjs test [N]   (poll, then summarise N transcripts)

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES } from './banned-patterns.mjs';
import { chatJson, DEEPSEEK_MODEL, usageLine, requireDeepSeekKey } from './deepseek.mjs';
import { withHealth } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
const FEED = process.env.ALPHASTREET_FEED || 'https://alphastreet.com/india/category/transcripts/feed/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
export const ALPHASTREET_PROMPT_VERSION = 'concall-note.v1';

// ─── fetch + parse ──────────────────────────────────────────────────
function decode(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#8217;|&#8216;/g, "'").replace(/&#8220;|&#8221;/g, '"').replace(/&#8377;/g, '₹')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").trim();
}
function htmlToText(h) {
  return decode(String(h || '').replace(/<\/(p|div|h\d|li|br)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
// "Hariom Pipe Industries Ltd (HARIOMPIPE) Q4 2026 Earnings Call Transcript"
function parseTitle(t) {
  const m = String(t || '').match(/^(.*?)\s*\(([^)]+)\)\s*(Q[1-4]\s*(?:FY)?\s*\d{2,4}|FY\s*\d{2,4})?/i);
  return { company: (m?.[1] || t || '').trim(), ticker: (m?.[2] || '').trim().toUpperCase(), quarter: (m?.[3] || '').replace(/\s+/g, ' ').trim() };
}

async function fetchFeed() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const r = await fetch(FEED, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/rss+xml,*/*' } });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

function parseItems(xml) {
  const blocks = xml.split('<item>').slice(1).map(b => b.split('</item>')[0]);
  const one = (b, tag) => { const m = b.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? decode(m[1]) : null; };
  return blocks.map(b => {
    const title = one(b, 'title');
    const enc = b.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/);
    const { company, ticker, quarter } = parseTitle(title);
    return {
      link: one(b, 'link'), title, company, ticker, quarter,
      pub_date: one(b, 'pubDate'),
      transcript: htmlToText(enc ? enc[1] : (one(b, 'description') || '')),
    };
  }).filter(it => it.link && it.transcript && it.transcript.length > 500);
}

// ─── storage ────────────────────────────────────────────────────────
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alphastreet_raw (
     link TEXT PRIMARY KEY, company TEXT, ticker TEXT, quarter TEXT, title TEXT,
     pub_date TEXT, transcript TEXT, fetched_at INTEGER )`,
  `CREATE INDEX IF NOT EXISTS idx_as_ticker ON alphastreet_raw(ticker)`,
];
function openDb() {
  const path = process.env.DB_PATH || DEFAULT_DB;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  for (const s of SCHEMA) db.prepare(s).run();
  return db;
}

export async function pollAlphastreet() {
  const items = parseItems(await fetchFeed());
  const db = openDb();
  const existing = new Set(db.prepare('SELECT link FROM alphastreet_raw').all().map(r => r.link));
  const ins = db.prepare(`INSERT OR REPLACE INTO alphastreet_raw
    (link, company, ticker, quarter, title, pub_date, transcript, fetched_at)
    VALUES (@link,@company,@ticker,@quarter,@title,@pub_date,@transcript,@fetched_at)`);
  let neu = 0;
  for (const it of items) { if (!existing.has(it.link)) neu++; ins.run({ ...it, fetched_at: Date.now() }); }
  db.close();
  return { fetched: items.length, neu, items };
}

// ─── summarise (DeepSeek harness) ───────────────────────────────────
const SYSTEM = `You are a markets editor for Tipsheet. Summarise one Indian earnings-call transcript into a concise Concall Note. The transcript is your only source — every number, name, quote must come from it. No outside knowledge, no invented market reaction.

VOICE: FT Lex / Heard on the Street. Sentence case, active voice, named subjects, varied sentence length, one idea per sentence. Lead with what management actually said that matters, not "the call covered". Take a position grounded in the transcript.

BANNED: underscores/highlights/showcases/emphasizes; "not just X but Y"; moreover/furthermore/additionally; significant/robust/crucial/pivotal/seamless; leverage/navigate/unlock; announces/notes; opening adverbs; rhetorical questions; "in conclusion/overall/ultimately". Bold absolute numbers and percentages in the_brief. End on the verdict.

Return ONLY JSON:
{
 "headline": "<=90 chars, the company is the subject, the single most important takeaway",
 "the_take": "one-line editorial verdict on the quarter/guidance",
 "whats_new": ["<=120 chars","<=120 chars","3-5 sharp points management actually made"],
 "key_quotes": [{"quote":"verbatim from transcript <=200 chars","attribution":"name — title"}],
 "the_brief": "120-180 words synthesising the call: results, guidance, the real signal. Bold the numbers. End on the verdict.",
 "guidance_signal": "one of: Raised | Held | Cut | None — did management change guidance?",
 "sentiment": "one of: Adverse | Cautious | Neutral | Constructive | Bullish"
}`;

const VALID_GUIDANCE = ['Raised', 'Held', 'Cut', 'None'];
const VALID_SENT = ['Adverse', 'Cautious', 'Neutral', 'Constructive', 'Bullish'];

function buildFeedback(v) {
  const lines = ['Your previous output broke house style. Rewrite the ENTIRE JSON, same schema, fixing:'];
  if (v.banned?.length) lines.push(`- Banned: ${v.banned.map(b => `"${b}"`).join(', ')} — use the concrete fact.`);
  if (v.structural?.includes('monotone_sentence_lengths')) lines.push('- Vary sentence length in the_brief (mix short 6-12 word and long 20-30 word).');
  if (v.structural?.includes('em_dash_overuse')) lines.push('- At most one em-dash.');
  if (v.structural?.includes('summary_close')) lines.push('- No wrap-up close; end on the verdict.');
  return lines.join('\n');
}

function validate(p, src) {
  const issues = [];
  if (!p.headline || p.headline.length > 95) issues.push('headline');
  if (!p.the_brief || p.the_brief.length < 150) issues.push('the_brief_thin');
  if (!Array.isArray(p.whats_new) || !p.whats_new.length) issues.push('whats_new_empty');
  if (!VALID_GUIDANCE.includes(p.guidance_signal)) issues.push('guidance_invalid');
  if (!VALID_SENT.includes(p.sentiment)) issues.push('sentiment_invalid');
  const prose = [p.headline, p.the_take, ...(p.whats_new || []), p.the_brief].filter(Boolean).join(' ');
  const banned = []; for (const re of PHRASE_PATTERNS) { const m = prose.match(re); if (m) banned.push(m[0]); }
  if (banned.length) issues.push(`banned:${banned.slice(0, 4).join('|')}`);
  const structural = []; for (const r of STRUCTURAL_RULES) { const h = r(prose, { full_read: p.the_brief }); if (h) structural.push(h.name); }
  if (structural.length) issues.push(`structural:${structural.join('|')}`);
  return { ok: issues.length === 0, issues, banned, structural };
}

export async function summariseConcall(row, prev = null) {
  const user = `Company: ${row.company} (${row.ticker}) · ${row.quarter}\n\nTRANSCRIPT:\n${(row.transcript || '').slice(0, 60000)}`;
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  if (prev?.parsed && prev?.validation?.issues?.length) {
    messages.push({ role: 'assistant', content: JSON.stringify(prev.parsed) });
    messages.push({ role: 'user', content: buildFeedback(prev.validation) });
  }
  const res = await chatJson({ messages, temperature: 0.4, maxTokens: 1600 });
  if (!res.parsed) return { ok: false, error: res.error };
  const v = validate(res.parsed, row.transcript);
  return { ok: v.ok, parsed: res.parsed, validation: v, usage: res.usage, elapsed_ms: res.elapsed_ms, _res: res };
}

async function summariseWithRetry(row, max = 3) {
  let r = await summariseConcall(row); let tries = 1;
  while (!r.ok && r.validation?.issues?.length && tries < max) { r = await summariseConcall(row, r); tries++; }
  return { ...r, tries };
}

// ─── CLI ────────────────────────────────────────────────────────────
async function main() {
  const { fetched, neu, items } = await pollAlphastreet();
  console.log(`\n  AlphaStreet: ${fetched} transcripts · ${neu} new\n`);
  for (const it of items) console.log(`  • [${(it.ticker || '?').padEnd(11)}] ${it.quarter.padEnd(8)} ${it.company}  (${(it.transcript.length / 1000).toFixed(0)}k chars) · ${(it.pub_date || '').replace(/ \+.*/, '')}`);
}

async function testMain() {
  const n = Number(process.argv[3] || 2);
  const { items } = await pollAlphastreet();
  console.log(`DeepSeek ${DEEPSEEK_MODEL} · summarising ${n} of ${items.length} transcripts\n`);
  for (const row of items.slice(0, n)) {
    console.log('━'.repeat(88));
    console.log(`${row.company} (${row.ticker}) ${row.quarter} · ${(row.transcript.length / 1000).toFixed(0)}k chars`);
    const r = await summariseWithRetry(row);
    if (!r.parsed) { console.log('  FAILED:', r.error); continue; }
    const p = r.parsed;
    console.log(`  ok=${r.ok} tries=${r.tries} · ${usageLine(r._res)} · [${p.guidance_signal} guidance · ${p.sentiment}]`);
    if (!r.ok) console.log('  issues:', r.validation.issues.join(' | '));
    console.log(`\n  HEADLINE: ${p.headline}`);
    console.log(`  TAKE:     ${p.the_take}`);
    console.log(`  WHATS NEW:${(p.whats_new || []).map(s => '\n            • ' + s).join('')}`);
    if (p.key_quotes?.[0]) console.log(`  QUOTE:    "${p.key_quotes[0].quote}" — ${p.key_quotes[0].attribution}`);
    console.log(`\n  THE BRIEF:\n  ${(p.the_brief || '').replace(/\*\*/g, '').replace(/(.{1,84})(\s|$)/g, '$1\n  ').trim()}\n`);
  }
}

// ─── persist (run) mode → alphastreet_enriched ──────────────────────
const ENRICHED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS alphastreet_enriched (
     link TEXT PRIMARY KEY, ticker TEXT, company TEXT, quarter TEXT, pub_date TEXT,
     headline TEXT, the_take TEXT, whats_new TEXT, key_quotes TEXT, the_brief TEXT,
     guidance_signal TEXT, sentiment TEXT, model_used TEXT, prompt_version TEXT,
     enriched_at INTEGER, validation_ok INTEGER, validation_issues TEXT )`,
  `CREATE INDEX IF NOT EXISTS idx_as_enr ON alphastreet_enriched(validation_ok, enriched_at DESC)`,
];

async function runMode() {
  const limit = Number(process.argv[3] || 12);
  await pollAlphastreet();
  const db = openDb();
  for (const s of ENRICHED_SCHEMA) db.prepare(s).run();
  const pending = db.prepare(`SELECT * FROM alphastreet_raw
     WHERE link NOT IN (SELECT link FROM alphastreet_enriched) ORDER BY pub_date DESC LIMIT ?`).all(limit);
  console.log(`[alphastreet-enrich] ${pending.length} pending`);
  const ins = db.prepare(`INSERT OR REPLACE INTO alphastreet_enriched
    (link, ticker, company, quarter, pub_date, headline, the_take, whats_new, key_quotes, the_brief,
     guidance_signal, sentiment, model_used, prompt_version, enriched_at, validation_ok, validation_issues)
    VALUES (@link,@ticker,@company,@quarter,@pub_date,@headline,@the_take,@whats_new,@key_quotes,@the_brief,
     @guidance_signal,@sentiment,@model_used,@prompt_version,@enriched_at,@validation_ok,@validation_issues)`);
  let ok = 0, held = 0, failed = 0;
  for (const row of pending) {
    const r = await summariseWithRetry(row);
    if (!r.parsed) { failed++; console.log(`  ! ${row.ticker} ${r.error}`); continue; }
    const p = r.parsed;
    ins.run({
      link: row.link, ticker: row.ticker, company: row.company, quarter: row.quarter, pub_date: row.pub_date,
      headline: p.headline, the_take: p.the_take || '', whats_new: JSON.stringify(p.whats_new || []),
      key_quotes: JSON.stringify(p.key_quotes || []), the_brief: p.the_brief || '',
      guidance_signal: p.guidance_signal || '', sentiment: p.sentiment || '',
      model_used: DEEPSEEK_MODEL, prompt_version: ALPHASTREET_PROMPT_VERSION, enriched_at: Date.now(),
      validation_ok: r.ok ? 1 : 0, validation_issues: JSON.stringify(r.validation?.issues || []),
    });
    r.ok ? ok++ : held++;
  }
  console.log(`[alphastreet-enrich] persisted ok=${ok} held-for-review=${held} failed=${failed}`);
  db.close();
}

const _cmd = import.meta.url === pathToFileURL(process.argv[1]).href ? (process.argv[2] || 'poll') : null;
if (_cmd) requireDeepSeekKey('alphastreet');
if (_cmd === 'test') testMain().catch(e => { console.error(e); process.exit(1); });
else if (_cmd === 'run') withHealth('alphastreet', runMode).catch(e => { console.error(e); process.exit(1); });
else if (_cmd) main().catch(e => { console.error('alphastreet failed:', e.message); process.exit(1); });
