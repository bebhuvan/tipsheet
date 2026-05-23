// Concall Note enricher. Takes a row from concalls_raw and produces a Filings Concall Note.
//
// Design notes:
//   • Reuses the validator from banned-patterns.mjs (same anti-AI-slop rules apply).
//   • The ai_summary field is a JSON-stringified blob ~10-20KB; we extract relevant keys
//     and truncate, so the LLM input stays bounded.
//   • The management_consistency field is sent in full — it is the unique IP.
//   • Same Gemini 3.1 Flash Lite config as filings (temperature 1.0, max_tokens 1500).
//   • Implicit caching: system prompt is byte-identical across calls.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES, FEEDBACK_SUBSTITUTIONS } from './banned-patterns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/concalls_system.txt');
const USER_PROMPT_PATH   = resolve(__dirname, 'prompts/concalls_user.txt');
export const CONCALL_PROMPT_VERSION = 'concall-note.v1';

const CFG = {
  baseUrl:     process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey:      process.env.LLM_API_KEY  || process.env.GOOGLE_API_KEY,
  model:       process.env.LLM_MODEL    || 'gemini-3.1-flash-lite',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS || 1500),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS || 30000),
};

let _system, _userTemplate;
async function loadPrompts() {
  if (!_system)       _system       = await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  if (!_userTemplate) _userTemplate = await readFile(USER_PROMPT_PATH,   'utf8');
  return { system: _system, userTemplate: _userTemplate };
}

/**
 * The Tijori ai_summary is a stringified JSON like:
 *   { "Management Consistency Check": [...], "Key Quote": [...], "Sentiment - Own Business": [...], ... }
 * It can be 10-20KB. We pull the high-signal keys and produce a compact text extract.
 */
function extractFromAiSummary(rawJsonString, { maxChars = 4000 } = {}) {
  if (!rawJsonString || typeof rawJsonString !== 'string') return '';
  let obj;
  try { obj = JSON.parse(rawJsonString); } catch { return rawJsonString.slice(0, maxChars); }
  if (!obj || typeof obj !== 'object') return rawJsonString.slice(0, maxChars);

  const priorityKeys = [
    'Key Quote',
    'Sentiment - Own Business',
    'Sentiment - Sector and Competitive Backdrop',
    'Guidance',
    'Capex',
    'Order Book',
    'Margins',
    'Volume',
    'Pricing',
    'Strategy',
    'Risks',
  ];
  const parts = [];
  for (const key of priorityKeys) {
    if (key in obj) {
      const v = obj[key];
      const text = Array.isArray(v) ? v.map(stringify).join(' | ') : stringify(v);
      if (text) parts.push(`${key}: ${text}`);
    }
  }
  // Then anything else we haven't surfaced
  for (const [k, v] of Object.entries(obj)) {
    if (priorityKeys.includes(k)) continue;
    if (k === 'Management Consistency Check') continue;  // sent separately
    const text = Array.isArray(v) ? v.map(stringify).join(' | ') : stringify(v);
    if (text) parts.push(`${k}: ${text}`);
  }
  return parts.join('\n').slice(0, maxChars);
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Extract the human-readable text from the management_consistency field, dropping the JSON wrapper. */
function extractMgmtConsistency(rawJsonString) {
  if (!rawJsonString || typeof rawJsonString !== 'string') return '(none)';
  let obj;
  try { obj = JSON.parse(rawJsonString); } catch { return rawJsonString.slice(0, 4000); }
  const arr = obj?.['Management Consistency Check'];
  if (!Array.isArray(arr) || arr.length === 0) return '(none)';
  const text = arr.join('\n\n');
  // Sometimes the only entry is "No material inconsistencies identified in recent concalls" —
  // we surface that to the LLM so it knows there's nothing to lead on.
  return text.slice(0, 4000);
}

function buildUserMessage(template, raw) {
  const ai_summary_extracts  = extractFromAiSummary(raw.ai_summary);
  const management_consistency = extractMgmtConsistency(raw.management_consistency);
  return template
    .replace('{company}',           raw.company_name || '?')
    .replace('{symbol}',            raw.symbol || raw.slug || '?')
    .replace('{sector}',            raw.sector || '?')
    .replace('{event_time}',        raw.event_time || '?')
    .replace('{summary_highlight}', raw.summary_highlight || '(none)')
    .replace('{management_consistency}', management_consistency)
    .replace('{ai_summary_extracts}',    ai_summary_extracts || '(no ai_summary extracts)');
}

function buildFeedbackMessage(validation) {
  const lines = ['Your previous Concall Note had these problems. Rewrite the entire JSON without them.'];
  if (validation.banned?.length) {
    lines.push('');
    lines.push(`Banned phrases you used: ${validation.banned.map(b => `"${b}"`).join(', ')}`);
    lines.push('Permitted substitutions:');
    for (const [from, to] of FEEDBACK_SUBSTITUTIONS) lines.push(`  - ${from} → ${to}`);
  }
  if (validation.structural?.length) {
    lines.push('');
    lines.push('Structural problems detected — these need active rewriting, not just word swaps:');
    for (const s of validation.structural) {
      lines.push(`  - ${s.name}: ${s.evidence}`);
      if (s.name === 'monotone_sentence_lengths') {
        lines.push('    FIX: Add at least one short sentence (6-12 words) AND one long sentence (20-30 words) inside "the_brief". Even better, add a single-sentence paragraph or fragment for emphasis: "Not yet." / "Hardly." / "Three quarters in a row." This single change is the most reliable way to break monotone.');
      } else if (s.name === 'em_dash_overuse') {
        lines.push('    FIX: Replace em-dashes with commas, parentheses, or periods. Keep at MOST one em-dash in the entire piece.');
      } else if (s.name === 'negative_parallelism' || s.name === 'em_dashed_parallelism') {
        lines.push('    FIX: Delete the "not just X, but Y" construction entirely. Pick one — say only what is true.');
      } else if (s.name === 'sentence_opening_adverb') {
        lines.push('    FIX: Strip the opening adverb. The sentence should carry its emphasis without "Notably,", "Importantly,", "Crucially,".');
      }
    }
  }
  if (validation.fabricated?.length) {
    lines.push('');
    lines.push(`Numbers in your output not present in the input: ${validation.fabricated.join(', ')}`);
    lines.push('Use only numbers verbatim from the input. If a number is wrong, remove it.');
  }
  const otherIssues = (validation.issues || []).filter(i => !i.startsWith('banned') && !i.startsWith('fabricated') && !i.startsWith('structural'));
  if (otherIssues.length) {
    lines.push('');
    lines.push(`Schema issues: ${otherIssues.join(', ')}`);
  }
  lines.push('');
  lines.push('Return the corrected JSON object. Same schema. No commentary outside the JSON.');
  return lines.join('\n');
}

export async function enrichConcall(raw, previousAttempt = null) {
  if (!CFG.apiKey) return { ok: false, error: 'missing API key (LLM_API_KEY / GOOGLE_API_KEY)' };
  const { system, userTemplate } = await loadPrompts();
  const userMsg = buildUserMessage(userTemplate, raw);

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: userMsg },
  ];
  if (previousAttempt?.parsed && previousAttempt?.validation?.issues?.length) {
    messages.push(
      { role: 'assistant', content: JSON.stringify(previousAttempt.parsed) },
      { role: 'user',      content: buildFeedbackMessage(previousAttempt.validation) },
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${CFG.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${CFG.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: CFG.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: CFG.temperature,
        max_tokens: CFG.maxTokens,
      }),
    });
    const elapsed_ms = Date.now() - t0;
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `HTTP ${r.status}`, raw_error: body.slice(0, 300), elapsed_ms };
    }
    const body = await r.json();
    const content = body.choices?.[0]?.message?.content ?? '';
    const start = content.indexOf('{');
    const end   = content.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no_json', raw_text: content.slice(0, 300), elapsed_ms };
    let parsed;
    try { parsed = JSON.parse(content.slice(start, end + 1)); }
    catch (e) { return { ok: false, error: 'json_parse', raw_error: e.message, elapsed_ms }; }

    const v = validate(parsed, raw);
    return {
      ok: v.ok,
      parsed,
      validation: v,
      model: CFG.model,
      promptVersion: CONCALL_PROMPT_VERSION,
      usage: body.usage || null,
      elapsed_ms,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, elapsed_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function validate(parsed, raw) {
  const issues = [];
  if (typeof parsed?.headline !== 'string') issues.push('headline_missing');
  else if (parsed.headline.length > 100) issues.push(`headline_too_long:${parsed.headline.length}`);
  if (typeof parsed?.dek !== 'string') issues.push('dek_missing');
  else if (parsed.dek.length > 240) issues.push(`dek_too_long:${parsed.dek.length}`);
  if (!Array.isArray(parsed?.whats_new) || parsed.whats_new.length === 0) issues.push('whats_new_empty');
  if (typeof parsed?.the_brief !== 'string') issues.push('the_brief_missing');
  else if (parsed.the_brief.length < 200) issues.push(`the_brief_thin:${parsed.the_brief.length}`);
  else if (parsed.the_brief.length > 1400) issues.push(`the_brief_too_long:${parsed.the_brief.length}`);
  if (typeof parsed?.the_take !== 'string' || parsed.the_take.length < 20) issues.push('the_take_thin');
  if (!Array.isArray(parsed?.key_quotes)) issues.push('key_quotes_missing');

  const prose = [
    parsed?.headline, parsed?.dek, parsed?.inconsistency_flag,
    ...(parsed?.whats_new || []),
    ...((parsed?.key_quotes || []).map(q => q?.quote || '')),
    parsed?.the_brief, parsed?.the_take,
  ].filter(Boolean).join(' ');

  const banned = [];
  for (const pat of PHRASE_PATTERNS) {
    const m = prose.match(pat);
    if (m) banned.push(m[0]);
  }
  if (banned.length) issues.push(`banned:${banned.slice(0, 5).join('|')}`);

  const structural = [];
  for (const rule of STRUCTURAL_RULES) {
    const hit = rule(prose, { full_read: parsed?.the_brief });
    if (hit) structural.push(hit);
  }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  // Number fidelity check against the input
  const src = (raw.management_consistency || '') + ' ' + (raw.ai_summary || '') + ' ' + (raw.summary_highlight || '');
  const srcNums = new Set((src.match(/\d[\d,.]*/g) || []).map(s => s.replace(/[,\s]/g, '')));
  const outNums = (prose.match(/\d[\d,.]*/g) || []).map(s => s.replace(/[,\s]/g, ''));
  const fabricated = outNums.filter(n => {
    if (n.length < 3) return false;
    if (srcNums.has(n)) return false;
    for (const s of srcNums) {
      if (s.startsWith(n) || (n.startsWith(s) && n.length - s.length <= 1)) return false;
    }
    return true;
  });
  if (fabricated.length) issues.push(`fabricated:${fabricated.slice(0, 5).join(',')}`);

  return { ok: issues.length === 0, issues, banned, structural, fabricated };
}
