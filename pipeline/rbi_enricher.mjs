// RBI enricher — turns an rbi_raw item into a Tipsheet macro/regulatory note via DeepSeek.
//
// Key finding (2026-05-24): RBI's RSS <description> carries the FULL content incl. HTML data
// tables, so press releases / notifications / most data releases need NO PDF fetch — we enrich
// straight from the stored description. (RBI's own pages are JS-rendered, so this is also the
// robust path.) The Bulletin's multi-article PDF cluster is the one case still needing the PDF
// flow; handled separately.
//
// Uses DeepSeek (OpenAI-compatible) per the decision to route this source through DeepSeek, and
// reuses the house anti-slop validators from banned-patterns.mjs.
//
// Test:  node --env-file=../.env rbi_enricher.mjs test [N]

import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { PHRASE_PATTERNS, STRUCTURAL_RULES } from './banned-patterns.mjs';
import { chatJson, DEEPSEEK_MODEL, requireDeepSeekKey } from './deepseek.mjs';
import { withHealth } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
export const RBI_PROMPT_VERSION = 'rbi-note.v2';

const CATEGORIES = ['Monetary Policy', 'Banking Regulation', 'Macro Data', 'Enforcement', 'Report'];

const SYSTEM = `You are a markets editor for an Indian-finance publication, Tipsheet. You write a short macro/regulatory note from one RBI release (circular, press release, or data print). The SOURCE text is your entire universe of facts — every number, date, name must come from it. No outside knowledge, no invented market reaction.

VOICE: Financial Times Lex / Buttonwood. Sentence case, active voice, named subjects ("RBI", "scheduled commercial banks"), one idea per sentence, varied sentence length. Lead with what RBI did and what it means, never the procedure. Take a position grounded in the facts.

BANNED: underscores/highlights/showcases/emphasizes; "not just X but Y"; moreover/furthermore/additionally; significant/robust/crucial/pivotal/seamless; leverage/navigate/unlock; "in conclusion"/"overall"/"ultimately"; "announces/discloses/notes"; opening adverbs ("Notably,"); rhetorical questions; unsourced "investors/markets/analysts expect". Bold absolute numbers and percentages in the_read. End on the verdict.

CATEGORY (drives which section it publishes to — choose carefully):
- "Macro Data": data prints — forex reserves, lending/deposit rates, trade, sectoral credit, money supply, GDP/CPI/IIP. Lead with the number that moved and its direction; the_read explains the signal.
- "Monetary Policy": ONLY actual policy/rate decisions — repo rate, MPC, CRR/SLR, liquidity/OMO operations.
- "Banking Regulation": prudential/licensing/IRAC/exposure rule changes. Lead with the rule and who it binds.
- "Enforcement": penalties, licence cancellations, directions against an entity.
- "Report": Bulletin, surveys, FSR.

Return ONLY JSON:
{
 "headline": "<=90 chars, RBI/the bank is the subject, active verb, no 'announces'",
 "dek": "<=200 chars, the bottom line first",
 "what_changed": ["<=120 chars", "<=120 chars", "optional 3rd"],
 "the_read": "60-150 words, the editorial judgment, bold the numbers, end on the verdict",
 "category": "one of: Monetary Policy | Banking Regulation | Macro Data | Enforcement | Report",
 "key_numbers": ["0-4 short 'label: value' strings taken verbatim from the source"]
}`;

function htmlToText(h) {
  return (h || '')
    .replace(/<\/(td|th)>/gi, ' | ').replace(/<\/(tr|p|div|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#8377;/g, '₹').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function buildFeedback(v) {
  const lines = ['Your previous output broke house style. Rewrite the ENTIRE JSON fixing these, same schema, no commentary:'];
  if (v.banned?.length) lines.push(`- Banned words/phrases used: ${v.banned.map(b => `"${b}"`).join(', ')}. Replace with the concrete fact, not a synonym.`);
  if (v.structural?.includes('em_dash_overuse')) lines.push('- Too many em-dashes. Use at most one in the whole note; prefer commas/periods.');
  if (v.structural?.includes('monotone_sentence_lengths')) lines.push('- Sentences are monotone. Vary length: mix a 6-12 word sentence with a 20-30 word one.');
  if (v.structural?.includes('summary_close')) lines.push('- Drop the wrap-up close ("Overall,", "In conclusion,"). End on the verdict itself.');
  if (v.issues?.some(i => i.startsWith('the_read'))) lines.push('- the_read must be 60-150 words of real analysis.');
  return lines.join('\n');
}

export async function enrichRbi(row, prev = null) {
  const body = htmlToText(row.summary).slice(0, 24000);  // headroom for long Bulletin articles
  const user = `Title: ${row.title}\nKind: ${row.kind}\nDate: ${row.pub_date}\n\nSOURCE:\n${body || '(no content in feed — likely needs the PDF)'}`;
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  if (prev?.parsed && prev?.validation?.issues?.length) {
    messages.push({ role: 'assistant', content: JSON.stringify(prev.parsed) });
    messages.push({ role: 'user', content: buildFeedback(prev.validation) });
  }
  // Transport (retries/backoff/timeout/usage) handled by the shared DeepSeek harness.
  const res = await chatJson({ messages, temperature: 0.4, maxTokens: 1500 });
  if (!res.parsed) return { ok: false, error: res.error, detail: res.content, elapsed_ms: res.elapsed_ms };
  const v = validate(res.parsed, body + ' ' + row.title);
  return { ok: v.ok, parsed: res.parsed, validation: v, model: res.model, elapsed_ms: res.elapsed_ms, usage: res.usage, src_chars: body.length };
}

// Enrich with the feedback-retry loop (up to `max` attempts), like the Gemini enricher.
export async function enrichRbiWithRetry(row, max = 3) {
  let res = await enrichRbi(row);
  let tries = 1;
  while (!res.ok && res.validation?.issues?.length && tries < max) { res = await enrichRbi(row, res); tries++; }
  return { ...res, tries };
}

function validate(p, src) {
  const issues = [];
  if (!p.headline || p.headline.length > 95) issues.push('headline');
  if (!p.the_read || p.the_read.length < 150) issues.push('the_read_thin');
  if (!Array.isArray(p.what_changed) || !p.what_changed.length) issues.push('what_changed_empty');
  if (!CATEGORIES.includes(p.category)) issues.push('category_invalid');
  const prose = [p.headline, p.dek, ...(p.what_changed || []), p.the_read].filter(Boolean).join(' ');
  const banned = []; for (const re of PHRASE_PATTERNS) { const m = prose.match(re); if (m) banned.push(m[0]); }
  if (banned.length) issues.push(`banned:${banned.slice(0, 4).join('|')}`);
  const structural = []; for (const r of STRUCTURAL_RULES) { const h = r(prose, { full_read: p.the_read }); if (h) structural.push(h.name); }
  if (structural.length) issues.push(`structural:${structural.join('|')}`);
  return { ok: issues.length === 0, issues, banned, structural };
}

async function testMain() {
  const limit = Number(process.argv[3] || 4);
  const db = new Database(resolve(process.env.DB_PATH || DEFAULT_DB), { readonly: true });
  const picks = db.prepare(`SELECT * FROM rbi_raw WHERE passed_gate=1 AND (
     title LIKE '%Lending and Deposit Rates%' OR title LIKE '%Sectoral Deployment%'
     OR title LIKE '%Trade in Services%' OR title LIKE '%Provisioning%' OR title LIKE '%amalgamation%')
     LIMIT ?`).all(limit);
  db.close();
  console.log(`DeepSeek ${DEEPSEEK_MODEL} · testing ${picks.length} RBI items\n`);
  for (const row of picks) {
    console.log('━'.repeat(88));
    console.log(`[${row.feed}] ${row.title}`);
    const r = await enrichRbiWithRetry(row);
    if (!r.parsed) { console.log('  FAILED:', r.error, r.detail || ''); continue; }
    const p = r.parsed;
    console.log(`  ok=${r.ok} tries=${r.tries} ${r.elapsed_ms}ms src=${r.src_chars}ch [${p.category}]${r.ok ? '' : '  issues: ' + r.validation.issues.join(' | ')}`);
    console.log(`\n  HEADLINE: ${p.headline}`);
    console.log(`  DEK:      ${p.dek}`);
    console.log(`  CHANGED:  ${(p.what_changed || []).map(s => '\n            • ' + s).join('')}`);
    console.log(`  NUMBERS:  ${(p.key_numbers || []).join('  ·  ')}`);
    console.log(`\n  THE READ:\n  ${(p.the_read || '').replace(/\*\*/g, '').replace(/(.{1,84})(\s|$)/g, '$1\n  ').trim()}\n`);
  }
}

// ─── persist (run) mode: enrich un-enriched passed RBI items → rbi_enriched ───
const RBI_ENRICHED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rbi_enriched (
     link TEXT PRIMARY KEY, section TEXT, headline TEXT, dek TEXT, what_changed TEXT,
     the_read TEXT, category TEXT, key_numbers TEXT, model_used TEXT, prompt_version TEXT,
     enriched_at INTEGER, validation_ok INTEGER, validation_issues TEXT )`,
  `CREATE INDEX IF NOT EXISTS idx_rbi_enr_section ON rbi_enriched(section, enriched_at DESC)`,
];
// Locked taxonomy: Macro Data / Report → /economy; Monetary Policy / Banking Regulation /
// Enforcement → /regulation.
const ECONOMY_CATS = new Set(['Macro Data', 'Report']);
const sectionFor = (cat) => (ECONOMY_CATS.has(cat) ? 'economy' : 'regulation');

async function runMode() {
  const limit = Number(process.argv[3] || 25);
  const db = new Database(resolve(process.env.DB_PATH || DEFAULT_DB));
  db.pragma('journal_mode = WAL');
  for (const s of RBI_ENRICHED_SCHEMA) db.prepare(s).run();
  // kind='circular' = RSS-content items (incl data releases). kind='report' = PDF flow (deferred).
  const pending = db.prepare(`SELECT * FROM rbi_raw WHERE passed_gate=1 AND kind IN ('circular','bulletin')
     AND link NOT IN (SELECT link FROM rbi_enriched) LIMIT ?`).all(limit);
  console.log(`[rbi-enrich] ${pending.length} pending`);
  const ins = db.prepare(`INSERT OR REPLACE INTO rbi_enriched
    (link, section, headline, dek, what_changed, the_read, category, key_numbers,
     model_used, prompt_version, enriched_at, validation_ok, validation_issues) VALUES
    (@link,@section,@headline,@dek,@what_changed,@the_read,@category,@key_numbers,
     @model_used,@prompt_version,@enriched_at,@validation_ok,@validation_issues)`);
  let ok = 0, held = 0, failed = 0;
  for (const row of pending) {
    const r = await enrichRbiWithRetry(row);
    if (!r.parsed) { failed++; console.log(`  ! ${row.title?.slice(0, 60)} ${r.error}`); continue; }
    const p = r.parsed;
    ins.run({
      link: row.link, section: sectionFor(p.category),
      headline: p.headline, dek: p.dek, what_changed: JSON.stringify(p.what_changed || []),
      the_read: p.the_read || '', category: p.category || '', key_numbers: JSON.stringify(p.key_numbers || []),
      model_used: r.model, prompt_version: RBI_PROMPT_VERSION, enriched_at: Date.now(),
      validation_ok: r.ok ? 1 : 0, validation_issues: JSON.stringify(r.validation?.issues || []),
    });
    r.ok ? ok++ : held++;
  }
  console.log(`[rbi-enrich] persisted ok=${ok} held-for-review=${held} failed=${failed}`);
  db.close();
}

const _cmd = import.meta.url === pathToFileURL(process.argv[1]).href ? process.argv[2] : null;
if (_cmd === 'test' || _cmd === 'run') requireDeepSeekKey('rbi');
if (_cmd === 'test') testMain().catch(e => { console.error(e); process.exit(1); });
else if (_cmd === 'run') withHealth('rbi_enrichment', runMode).catch(e => { console.error(e); process.exit(1); });
