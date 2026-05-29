// Regulatory-note enricher: turns one NSE/BSE/SEBI circular (from circulars_raw) into a leaner
// Tipsheet "regulatory note". Mirrors enricher.mjs (same Gemini SDK, same KV-cache discipline:
// the system prompt is fixed, only the circular data varies) but uses a tighter schema.
//
// Reuses the house anti-slop validators verbatim (banned-patterns.mjs) so regulatory notes are
// held to the same voice bar as filing notes.
//
// Test live on stored survivors:
//   node --env-file=../.env circulars_enricher.mjs test        (runs a few high-value survivors)
//   node --env-file=../.env circulars_enricher.mjs test 6      (run up to 6)

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { withHealth } from './db.mjs';
import { GoogleGenAI } from '@google/genai';
import { compatHeaders, tokenParam } from './llm-compat.mjs';
import { PHRASE_PATTERNS, STRUCTURAL_RULES, FEEDBACK_SUBSTITUTIONS } from './banned-patterns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/circular_system.txt');
const DEFAULT_DB = resolve(__dirname, '../data/filings.db');
export const CIRCULAR_PROMPT_VERSION = 'circular-note.v2';

const CFG = {
  apiKey:      process.env.LLM_API_KEY  || process.env.GOOGLE_API_KEY,
  model:       process.env.LLM_MODEL    || 'gemini-3.1-flash-lite',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS || 1200),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
};

const REG_CATEGORIES = ['Enforcement', 'Surveillance', 'Corporate Action', 'Derivatives', 'Index', 'Market Structure', 'Listing'];
const SEVERITIES = ['Low', 'Medium', 'High'];

let _systemPrompt;
async function loadSystem() {
  if (!_systemPrompt) _systemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  return _systemPrompt;
}

function buildUserMessage(row) {
  const stocks = (() => { try { return JSON.parse(row.stocks || '[]'); } catch { return []; } })();
  const tags   = (() => { try { return JSON.parse(row.tags || '[]'); } catch { return []; } })();
  const lines = [
    `Source: ${(row.source || '?').toUpperCase()}`,
    `Title: ${row.title || '?'}`,
    `Upstream importance: ${row.importance || '?'}`,
    stocks.length ? `Affected stocks (${stocks.length}): ${stocks.slice(0, 25).join(', ')}${stocks.length > 25 ? ' …' : ''}` : '',
    tags.length ? `Tags: ${tags.join(', ')}` : '',
    '',
    'SUMMARY (your entire universe of facts):',
    (row.summary || '(no summary provided)').slice(0, 4000),
  ];

  // If the source PDF was extracted, hand the LLM the authoritative table as CONTEXT only.
  // The published table is rendered from this same data deterministically — the LLM must NOT
  // restate every row in prose; it references the headline counts/names and writes the read.
  const tableBlock = renderTablesForPrompt(row.pdf_tables);
  if (tableBlock) {
    lines.push('', 'AUTHORITATIVE LIST extracted from the source PDF (complete and exact — this is',
      'published as a table beneath your note; do NOT re-list every row in prose, cite only the',
      'headline names/counts and write the editorial read):', tableBlock.slice(0, 3000));
  }
  return lines.filter(Boolean).join('\n');
}

function parseTables(pdfTablesJson) {
  try { const t = JSON.parse(pdfTablesJson || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
}

function renderTablesForPrompt(pdfTablesJson) {
  const tables = parseTables(pdfTablesJson);
  if (!tables.length) return '';
  return tables.map(t => t.map(row => row.join(' | ')).join('\n')).join('\n---\n');
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    headline:        { type: 'STRING' },
    dek:             { type: 'STRING' },
    what_changed:    { type: 'ARRAY', items: { type: 'STRING' } },
    who_is_affected: { type: 'STRING' },
    effective_date:  { type: 'STRING' },
    the_read:        { type: 'STRING' },
    reg_category:    { type: 'STRING' },
    severity:        { type: 'STRING' },
    key_entities:    { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['headline', 'dek', 'what_changed', 'who_is_affected', 'effective_date',
             'the_read', 'reg_category', 'severity', 'key_entities'],
};

function buildFeedbackMessage(validation) {
  const lines = ['Your previous output had these problems. Rewrite the entire JSON without them.'];
  if (validation.banned?.length) {
    lines.push('', `Banned phrases you used: ${validation.banned.map(b => `"${b}"`).join(', ')}`, 'Permitted substitutions:');
    for (const [from, to] of FEEDBACK_SUBSTITUTIONS) lines.push(`  - ${from} → ${to}`);
  }
  if (validation.structural?.length) {
    lines.push('', 'Structural problems (rewrite, not word-swap):');
    for (const s of validation.structural) lines.push(`  - ${s.name}: ${s.evidence}`);
  }
  if (validation.fabricated?.length) {
    lines.push('', `Numbers not in the source: ${validation.fabricated.join(', ')}`,
      'Use only numbers verbatim from the summary or title. Do not do arithmetic.');
  }
  const other = (validation.issues || []).filter(i => !i.startsWith('banned') && !i.startsWith('fabricated') && !i.startsWith('structural'));
  if (other.length) lines.push('', `Schema issues: ${other.join(', ')}`);
  lines.push('', 'Return the corrected JSON. Same schema. No commentary.');
  return lines.join('\n');
}

export async function enrichCircular(row, previousAttempt = null) {
  if (!CFG.apiKey) return { ok: false, error: 'missing API key (set LLM_API_KEY or GOOGLE_API_KEY)' };
  const system = await loadSystem();
  const userMsg = buildUserMessage(row);

  // Non-Gemini providers (MiMo) use the OpenAI-compatible path.
  const baseUrl = process.env.LLM_BASE_URL || '';
  if (baseUrl && !/googleapis|generativelanguage/i.test(baseUrl)) {
    let user = userMsg;
    if (previousAttempt?.parsed && previousAttempt?.validation?.issues?.length) {
      user += `\n\nYour previous attempt:\n${JSON.stringify(previousAttempt.parsed)}\n\n${buildFeedbackMessage(previousAttempt.validation)}`;
    }
    const t0 = Date.now();
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: compatHeaders(baseUrl, CFG.apiKey),
        body: JSON.stringify({
          model: CFG.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
          temperature: CFG.temperature,
          ...tokenParam(baseUrl, CFG.maxTokens),
        }),
      });
      const elapsed_ms = Date.now() - t0;
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, elapsed_ms };
      const b = await r.json();
      const content = b.choices?.[0]?.message?.content ?? '';
      const s = content.indexOf('{'), e = content.lastIndexOf('}');
      let parsed;
      try { parsed = JSON.parse(s >= 0 && e > s ? content.slice(s, e + 1) : content); }
      catch (err) { return { ok: false, error: 'json_parse', raw_text: content.slice(0, 300), elapsed_ms }; }
      const v = validate(parsed, row);
      return { ok: v.ok, parsed, validation: v, model: CFG.model, promptVersion: CIRCULAR_PROMPT_VERSION, usage: b.usage || null, elapsed_ms };
    } catch (e) {
      return { ok: false, error: e.message, elapsed_ms: Date.now() - t0 };
    }
  }

  const contents = [];
  if (previousAttempt?.parsed && previousAttempt?.validation?.issues?.length) {
    contents.push({ role: 'user', parts: [{ text: userMsg }] });
    contents.push({ role: 'model', parts: [{ text: JSON.stringify(previousAttempt.parsed) }] });
    contents.push({ role: 'user', parts: [{ text: buildFeedbackMessage(previousAttempt.validation) }] });
  } else {
    contents.push({ role: 'user', parts: [{ text: userMsg }] });
  }

  const t0 = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey: CFG.apiKey });
    const response = await ai.models.generateContent({
      model: CFG.model,
      contents,
      config: {
        systemInstruction: system,
        temperature: CFG.temperature,
        maxOutputTokens: CFG.maxTokens,
        responseMimeType: 'application/json',
        responseSchema,
      },
    });
    const elapsed_ms = Date.now() - t0;
    const content = response.text || '';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { return { ok: false, error: 'json_parse', raw_text: content.slice(0, 300), elapsed_ms }; }

    const v = validate(parsed, row);
    return { ok: v.ok, parsed, validation: v, model: CFG.model, promptVersion: CIRCULAR_PROMPT_VERSION, usage: response.usageMetadata || null, elapsed_ms };
  } catch (e) {
    return { ok: false, error: e.message, elapsed_ms: Date.now() - t0 };
  }
}

// ─── validation (same anti-slop bar as filing notes) ────────────────
function validate(parsed, row) {
  const issues = [];
  if (typeof parsed.headline !== 'string') issues.push('headline_missing');
  else if (parsed.headline.length > 90) issues.push(`headline_too_long:${parsed.headline.length}`);
  if (typeof parsed.dek !== 'string') issues.push('dek_missing');
  else if (parsed.dek.length > 220) issues.push(`dek_too_long:${parsed.dek.length}`);
  if (!Array.isArray(parsed.what_changed) || parsed.what_changed.length === 0) issues.push('what_changed_empty');
  if (typeof parsed.who_is_affected !== 'string' || parsed.who_is_affected.length < 5) issues.push('who_is_affected_thin');
  if (typeof parsed.the_read !== 'string') issues.push('the_read_missing');
  else if (parsed.the_read.length < 150) issues.push(`the_read_thin:${parsed.the_read.length}`);
  else if (parsed.the_read.length > 1400) issues.push(`the_read_too_long:${parsed.the_read.length}`);
  if (!REG_CATEGORIES.includes(parsed.reg_category)) issues.push('reg_category_invalid');
  if (!SEVERITIES.includes(parsed.severity)) issues.push('severity_invalid');

  const proseText = [parsed.headline, parsed.dek, ...(parsed.what_changed || []), parsed.who_is_affected, parsed.the_read]
    .filter(Boolean).join(' ');

  const banned = [];
  for (const pat of PHRASE_PATTERNS) { const m = proseText.match(pat); if (m) banned.push(m[0]); }
  if (banned.length) issues.push(`banned:${banned.slice(0, 5).join('|')}`);

  const structural = [];
  for (const rule of STRUCTURAL_RULES) { const hit = rule(proseText, { full_read: parsed.the_read }); if (hit) structural.push(hit); }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  // Number fidelity vs the circular summary + title + affected stocks.
  const src = (row.summary || '') + ' ' + (row.title || '') + ' ' + (row.stocks || '');
  const srcNums = numberFingerprint(src);
  const outNums = numberFingerprint(proseText + ' ' + (parsed.effective_date || ''));
  const srcArr = [...srcNums];
  const fabricated = [...outNums].filter(n => {
    if (n.length < 3) return false;
    if (srcNums.has(n)) return false;
    for (const s of srcArr) { if (s.startsWith(n)) return false; if (n.startsWith(s) && n.length - s.length <= 1) return false; }
    return true;
  });
  if (fabricated.length) issues.push(`fabricated:${fabricated.slice(0, 5).join(',')}`);

  return { ok: issues.length === 0, issues, fabricated, banned, structural };
}

function numberFingerprint(text) {
  const matches = String(text || '').match(/\d[\d,.]*/g) || [];
  const out = new Set();
  for (const m of matches) { const n = m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, ''); if (n) out.add(n); }
  return out;
}

// ─── live test runner ───────────────────────────────────────────────
async function testMain() {
  const limit = Number(process.argv[3] || 4);
  const db = new Database(resolve(process.env.DB_PATH || DEFAULT_DB), { readonly: true });
  // Pick a spread: high-value SEBI orders + one bulk surveillance item to see thin-note behaviour.
  const picks = db.prepare(`
    SELECT * FROM circulars_raw WHERE passed_gate = 1 AND (
      title LIKE '%Religare%' OR title LIKE '%Bajaj Hindusthan%' OR title LIKE '%Market Maker%'
      OR title LIKE '%GSM Stage%' OR title LIKE '%Reconstitution of BSE%'
    ) ORDER BY source DESC LIMIT ?
  `).all(limit);
  db.close();

  if (!CFG.apiKey) { console.error('No API key (LLM_API_KEY / GOOGLE_API_KEY). Run with --env-file=../.env'); process.exit(1); }
  console.log(`Model: ${CFG.model} · testing ${picks.length} survivors\n`);

  for (const row of picks) {
    console.log('━'.repeat(90));
    console.log(`[${(row.source || '?').toUpperCase()} ${row.importance}] ${row.title}`);
    let res = await enrichCircular(row);
    let tries = 1;
    while (!res.ok && res.validation?.issues?.length && tries < 3) { res = await enrichCircular(row, res); tries++; }
    if (!res.parsed) { console.log('  FAILED:', res.error, res.raw_text || ''); continue; }
    const p = res.parsed;
    console.log(`  ok=${res.ok}  tries=${tries}  ${res.elapsed_ms}ms  [${p.reg_category} · ${p.severity}]`);
    if (!res.ok) console.log('  issues:', res.validation.issues.join(' | '));
    console.log(`\n  HEADLINE: ${p.headline}`);
    console.log(`  DEK:      ${p.dek}`);
    console.log(`  CHANGED:  ${(p.what_changed || []).map(s => '\n            • ' + s).join('')}`);
    console.log(`  AFFECTS:  ${p.who_is_affected}`);
    console.log(`  EFFECTIVE:${p.effective_date || ' —'}`);
    console.log(`  ENTITIES: ${(p.key_entities || []).join(' · ')}`);
    console.log(`\n  THE READ:\n  ${(p.the_read || '').replace(/\*\*/g, '').replace(/(.{1,86})(\s|$)/g, '$1\n  ').trim()}\n`);
    const tbls = parseTables(row.pdf_tables);
    if (tbls.length) {
      console.log('  ── SOURCE TABLE (extracted from PDF deterministically — the published list) ──');
      for (const t of tbls) { for (const r of t) console.log('   ' + r.join('  |  ')); }
      console.log('');
    }
  }
}

// ─── persist (run) mode: enrich un-enriched passed circulars → circulars_enriched ───
const ENRICHED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS circulars_enriched (
     circular_id TEXT PRIMARY KEY, section TEXT, headline TEXT, dek TEXT,
     what_changed TEXT, who_is_affected TEXT, effective_date TEXT, the_read TEXT,
     reg_category TEXT, severity TEXT, key_entities TEXT, has_table INTEGER,
     model_used TEXT, prompt_version TEXT, enriched_at INTEGER,
     validation_ok INTEGER, validation_issues TEXT )`,
  `CREATE INDEX IF NOT EXISTS idx_circ_enr_section ON circulars_enriched(section, enriched_at DESC)`,
];

export async function enrichCircularWithRetry(row, max = 3) {
  let res = await enrichCircular(row);
  let tries = 1;
  while (!res.ok && res.validation?.issues?.length && tries < max) { res = await enrichCircular(row, res); tries++; }
  return { ...res, tries };
}

async function runMode() {
  const limit = Number(process.argv[3] || 25);
  const db = new Database(resolve(process.env.DB_PATH || DEFAULT_DB));
  db.pragma('journal_mode = WAL');
  for (const s of ENRICHED_SCHEMA) db.prepare(s).run();
  const pending = db.prepare(`SELECT * FROM circulars_raw WHERE passed_gate=1
     AND circular_id NOT IN (SELECT circular_id FROM circulars_enriched) LIMIT ?`).all(limit);
  console.log(`[circulars-enrich] ${pending.length} pending`);
  const ins = db.prepare(`INSERT OR REPLACE INTO circulars_enriched
    (circular_id, section, headline, dek, what_changed, who_is_affected, effective_date, the_read,
     reg_category, severity, key_entities, has_table, model_used, prompt_version, enriched_at,
     validation_ok, validation_issues) VALUES
    (@circular_id,@section,@headline,@dek,@what_changed,@who_is_affected,@effective_date,@the_read,
     @reg_category,@severity,@key_entities,@has_table,@model_used,@prompt_version,@enriched_at,
     @validation_ok,@validation_issues)`);
  let ok = 0, held = 0, failed = 0;
  for (const row of pending) {
    const r = await enrichCircularWithRetry(row);
    if (!r.parsed) { failed++; console.log(`  ! ${row.circular_id} ${r.error}`); continue; }
    const p = r.parsed;
    ins.run({
      circular_id: row.circular_id, section: 'regulation',
      headline: p.headline, dek: p.dek, what_changed: JSON.stringify(p.what_changed || []),
      who_is_affected: p.who_is_affected || '', effective_date: p.effective_date || '',
      the_read: p.the_read || '', reg_category: p.reg_category || '', severity: p.severity || '',
      key_entities: JSON.stringify(p.key_entities || []),
      has_table: row.pdf_tables && row.pdf_tables !== '[]' ? 1 : 0,
      model_used: r.model, prompt_version: CIRCULAR_PROMPT_VERSION, enriched_at: Date.now(),
      validation_ok: r.ok ? 1 : 0, validation_issues: JSON.stringify(r.validation?.issues || []),
    });
    r.ok ? ok++ : held++;
  }
  console.log(`[circulars-enrich] persisted ok=${ok} held-for-review=${held} failed=${failed}`);
  db.close();
}

const _cmd = import.meta.url === pathToFileURL(process.argv[1]).href ? process.argv[2] : null;
if (_cmd === 'test') testMain().catch(e => { console.error(e); process.exit(1); });
else if (_cmd === 'run') withHealth('circulars_enrichment', runMode).catch(e => { console.error(e); process.exit(1); });
