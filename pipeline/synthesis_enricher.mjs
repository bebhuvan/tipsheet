// Results synthesis — "the numbers vs the call".
// Trigger: a company has BOTH an Earnings filing note and an enriched concall
// for the same results event (within 10 days). Output: one combined piece that
// sets the reported numbers against what management said on the call, using
// the concall's verified quotes, guidance and risk extractions.
//
// Pure cross-source synthesis of our own enriched content — no new scraping.
// Voice rules mirror prompts/system.txt; banned-pattern + structural + number
// and quote fidelity validation backstop them mechanically.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatHeaders, tokenParam } from './llm-compat.mjs';
import { PHRASE_PATTERNS, STRUCTURAL_RULES, FEEDBACK_SUBSTITUTIONS } from './banned-patterns.mjs';
import { buildCompanyContext } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PATH = resolve(__dirname, 'prompts/synthesis_system.txt');
const USER_PATH = resolve(__dirname, 'prompts/synthesis_user.txt');

export const SYNTHESIS_PROMPT_VERSION = 'results-synthesis.v1';

const CFG = {
  baseUrl:     process.env.LLM_BASE_URL || '',
  apiKey:      process.env.LLM_API_KEY || '',
  model:       process.env.LLM_MODEL || '',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS_SYNTHESIS || 2400),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS_SYNTHESIS || process.env.LLM_TIMEOUT_MS || 60000),
};
const FALLBACK = {
  baseUrl:     process.env.LLM_FALLBACK_BASE_URL || (process.env.DEEPSEEK_API_KEY ? 'https://api.deepseek.com' : ''),
  apiKey:      process.env.LLM_FALLBACK_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  model:       process.env.LLM_FALLBACK_MODEL || 'deepseek-v4-flash',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS_SYNTHESIS || 2400),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS_SYNTHESIS || process.env.LLM_TIMEOUT_MS || 60000),
};

export function ensureSynthesisTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS synthesis_enriched (
      symbol              TEXT NOT NULL,
      concall_event_time  TEXT NOT NULL,
      filing_record_id    INTEGER NOT NULL,
      slug                TEXT UNIQUE,
      company             TEXT,
      headline            TEXT,
      dek                 TEXT,
      the_numbers         TEXT,
      managements_story   TEXT,
      divergence          TEXT,
      what_were_watching  TEXT,
      the_full_read       TEXT,
      key_quote           TEXT,
      input_summary       TEXT,
      model_used          TEXT,
      prompt_version      TEXT,
      generated_at        INTEGER,
      validation_ok       INTEGER DEFAULT 0,
      validation_issues   TEXT,
      PRIMARY KEY (symbol, concall_event_time)
    );
  `);
}

// Concall+filing pairs that don't yet have a valid synthesis. One pair per
// concall: the closest Earnings filing within ±10 days. Failed attempts get
// retried after a 20h cooldown rather than on every run.
export function findSynthesisPairs(db, limit = 10) {
  ensureSynthesisTable(db);
  const retryCutoff = Date.now() - 20 * 3600 * 1000;
  const concalls = db.prepare(`
    SELECT c.symbol, ce.*
    FROM concalls_enriched ce
    JOIN concalls_raw c ON c.isin = ce.isin AND c.event_time = ce.event_time
    WHERE ce.validation_ok = 1
      AND NOT EXISTS (
        SELECT 1 FROM synthesis_enriched s
        WHERE s.symbol = c.symbol AND s.concall_event_time = ce.event_time
          AND (s.validation_ok = 1 OR s.generated_at > ?)
      )
    ORDER BY ce.event_time DESC
    LIMIT ?
  `).all(retryCutoff, limit * 3);

  const filingStmt = db.prepare(`
    SELECT r.record_id, r.symbol, r.company, r.score, r.created_on,
           e.headline, e.dek, e.the_number_value, e.the_number_label,
           e.whats_new, e.why_it_matters, e.the_full_read,
           COALESCE(r.event_category_canonical, e.canonical_category) AS canonical_category
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE r.symbol = ? AND e.validation_ok = 1
      AND COALESCE(r.event_category_canonical, e.canonical_category) = 'Earnings'
      AND abs(julianday(substr(?, 1, 10)) - julianday(substr(r.created_on, 1, 10))) <= 10
    ORDER BY abs(julianday(substr(?, 1, 10)) - julianday(substr(r.created_on, 1, 10))) ASC
    LIMIT 1
  `);

  const pairs = [];
  for (const ce of concalls) {
    const filing = filingStmt.get(ce.symbol, ce.event_time, ce.event_time);
    if (filing) pairs.push({ concall: ce, filing });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

function parseArr(s) { try { return s ? JSON.parse(s) : []; } catch { return []; } }

function buildUserMessage(template, { concall, filing }, companyContext) {
  const quotes = parseArr(concall.key_quotes)
    .map(q => `- "${q.quote}" — ${q.attribution || 'management'}`).join('\n');
  return template
    .replace('{company}', filing.company || concall.symbol)
    .replace('{symbol}', concall.symbol)
    .replace('{filing_note}', [
      `Headline: ${filing.headline}`,
      `Dek: ${filing.dek}`,
      filing.the_number_value ? `The number: ${filing.the_number_value} (${filing.the_number_label || ''})` : null,
      `What's new: ${parseArr(filing.whats_new).join(' | ')}`,
      `Why it matters: ${filing.why_it_matters}`,
      `Full read: ${filing.the_full_read}`,
    ].filter(Boolean).join('\n'))
    .replace('{concall_note}', [
      `Headline: ${concall.headline}`,
      `Dek: ${concall.dek}`,
      `The take: ${concall.the_take}`,
      `Brief: ${concall.the_brief}`,
      concall.inconsistency_flag ? `Inconsistency flag: ${concall.inconsistency_flag}` : null,
      `Themes: ${parseArr(concall.themes).map(t => `${t.label}: ${t.detail}`).join(' | ')}`,
      `Guidance watch: ${parseArr(concall.guidance_watch).join(' | ')}`,
      `Risk flags: ${parseArr(concall.risk_flags).join(' | ')}`,
    ].filter(Boolean).join('\n'))
    .replace('{quotes}', quotes || '(no quotes captured)')
    .replace('{company_context}', companyContext || '(none available)');
}

async function callModel(cfg, system, user) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: compatHeaders(cfg.baseUrl, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' },
        temperature: cfg.temperature,
        ...tokenParam(cfg.baseUrl, cfg.maxTokens),
      }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const body = await r.json();
    const text = body.choices?.[0]?.message?.content || '';
    try { return { parsed: JSON.parse(text), model: cfg.model, usage: body.usage || null }; }
    catch { return { error: 'parse_error', raw: text.slice(0, 400) }; }
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch_failed') };
  } finally {
    clearTimeout(timer);
  }
}

function numberFingerprint(text) {
  const out = new Set();
  for (const m of (String(text || '').match(/\d[\d,.]*/g) || [])) {
    const n = m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, '');
    if (n) out.add(n);
  }
  return out;
}

export function validateSynthesis(parsed, pair, companyContext) {
  const issues = [];
  const required = ['headline', 'dek', 'the_numbers', 'managements_story', 'divergence', 'what_were_watching', 'the_full_read'];
  for (const k of required) {
    const v = parsed?.[k];
    if (v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '')) issues.push(`missing:${k}`);
  }
  const proseText = [
    parsed?.headline, parsed?.dek,
    ...(parsed?.the_numbers || []), ...(parsed?.managements_story || []),
    parsed?.divergence, ...(parsed?.what_were_watching || []), parsed?.the_full_read,
  ].filter(Boolean).join('\n');

  const bannedMatches = [];
  for (const re of PHRASE_PATTERNS) {
    const m = proseText.match(re);
    if (m) bannedMatches.push(m[0]);
  }
  if (bannedMatches.length) issues.push(`banned:${bannedMatches.slice(0, 5).join('|')}`);

  const structural = [];
  for (const rule of STRUCTURAL_RULES) {
    const hit = rule(proseText, { full_read: parsed?.the_full_read });
    if (hit) structural.push(hit);
  }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  // Number fidelity vs ALL inputs (filing note + concall note + quotes + context).
  const { concall, filing } = pair;
  const src = [
    filing.headline, filing.dek, filing.the_number_value, filing.the_number_label,
    filing.whats_new, filing.why_it_matters, filing.the_full_read,
    concall.headline, concall.dek, concall.the_take, concall.the_brief,
    concall.themes, concall.guidance_watch, concall.risk_flags, concall.key_quotes,
    concall.inconsistency_flag, companyContext, filing.company, concall.symbol,
  ].filter(Boolean).join(' ');
  const srcNums = numberFingerprint(src);
  for (const m of (String(src).match(/FY[\s-]?(\d{2,4})/gi) || [])) {
    const yy = m.replace(/\D/g, '');
    if (yy.length === 2) srcNums.add('20' + yy);
    srcNums.add(yy);
  }
  const srcArr = [...srcNums];
  const fabricated = [...numberFingerprint(proseText)].filter(n => {
    if (n.length < 3) return false;
    if (srcNums.has(n)) return false;
    for (const s of srcArr) {
      if (s.startsWith(n)) return false;
      if (n.startsWith(s) && n.length - s.length <= 1) return false;
    }
    return true;
  });
  if (fabricated.length) issues.push(`fabricated:${fabricated.slice(0, 5).join(',')}`);

  // Quote fidelity: the chosen key_quote must be verbatim from the concall's
  // captured quotes — quotes are the one thing we can never paraphrase.
  if (parsed?.key_quote?.quote) {
    const allowed = parseArr(concall.key_quotes).map(q => String(q.quote || '').replace(/\s+/g, ' ').trim());
    const got = String(parsed.key_quote.quote).replace(/\s+/g, ' ').trim();
    if (!allowed.some(a => a === got || a.includes(got))) issues.push('quote_not_verbatim');
  }

  return { ok: issues.length === 0, issues, bannedMatches, structural, fabricated };
}

export function buildRetryFeedback(validation) {
  const lines = ['YOUR PREVIOUS ATTEMPT WAS REJECTED by our copy desk. Rewrite the whole piece fixing every problem below.'];
  if (validation.bannedMatches?.length) {
    lines.push('');
    lines.push(`Banned phrases you used: ${validation.bannedMatches.map(b => `"${b}"`).join(', ')}`);
    lines.push('Permitted substitutions:');
    for (const [from, to] of FEEDBACK_SUBSTITUTIONS) lines.push(`  - ${from} → ${to}`);
  }
  if (validation.structural?.length) {
    lines.push('');
    lines.push('Structural problems — rewrite the offending sentences, not just words:');
    for (const s of validation.structural) {
      lines.push(`  - ${s.name}: ${s.evidence || ''}`);
      if (s.name === 'magnitude_mismatch') lines.push('    (a word like "doubles"/"halves" sits next to a percentage that does not match it — separate the claims or drop the multiplier word)');
      if (s.name === 'negative_parallelism') lines.push('    (drop the "not just X, but Y" construction — state what is true directly)');
    }
  }
  if (validation.fabricated?.length) {
    lines.push('');
    lines.push(`Numbers not present in any source block: ${validation.fabricated.join(', ')} — remove them or replace with sourced figures. Do not derive new numbers.`);
  }
  if (validation.issues?.includes('quote_not_verbatim')) {
    lines.push('');
    lines.push('Your key_quote was not verbatim. Copy one quote EXACTLY, character for character, from the QUOTES block.');
  }
  return lines.join('\n');
}

let _system, _user;
export async function synthesizeOne(db, pair, previousValidation = null) {
  if (!_system) _system = await readFile(SYSTEM_PATH, 'utf8');
  if (!_user) _user = await readFile(USER_PATH, 'utf8');
  const companyContext = buildCompanyContext(db, { symbol: pair.concall.symbol, record_id: pair.filing.record_id });
  let userMsg = buildUserMessage(_user, pair, companyContext);
  if (previousValidation) {
    userMsg += '\n\n' + buildRetryFeedback(previousValidation);
  }

  let result = await callModel(CFG, _system, userMsg);
  if (result.error && FALLBACK.apiKey && FALLBACK.baseUrl) {
    result = await callModel(FALLBACK, _system, userMsg);
  }
  if (result.error) return { ok: false, error: result.error };

  const v = validateSynthesis(result.parsed, pair, companyContext);
  return { ok: v.ok, parsed: result.parsed, validation: v, model: result.model, companyContext };
}
