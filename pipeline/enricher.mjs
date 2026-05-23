// LLM enrichment + validation.
// System prompt is fixed and shared across all calls → DeepSeek KV cache hits on the prefix.
// User message is the only dynamic part (the filing data).
// This is what lets us pay $0.0028/M for cached input tokens instead of $0.14/M.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES, FEEDBACK_SUBSTITUTIONS } from './banned-patterns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/system.txt');
const USER_PROMPT_PATH   = resolve(__dirname, 'prompts/user.txt');
// v4 = v3 + structured editorial tone fields for article-level visual treatment
export const PROMPT_VERSION = 'filing-note.v4';

// Defaults tuned for Gemini 3.1 Flash Lite (the 22-May-2026 bakeoff winner):
//   - temperature: 1.0 per Google's explicit Gemini-3 guidance — "Changing the temperature
//     (setting it below 1.0) may lead to unexpected behavior, such as looping or degraded
//     performance" (ai.google.dev/gemini-api/docs/text-generation).
//   - maxTokens: 1500 — real outputs are 500-700 tokens; 1500 gives headroom without
//     letting a runaway response burn budget.
//   - Implicit context caching fires automatically on Gemini 2.5+ when the system prompt
//     prefix matches a prior request within the cache window (~85% hit rate observed when
//     calls are minutes apart). No code change required to benefit; just keep the system
//     prompt byte-identical across calls.
const CFG = {
  baseUrl:     process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey:      process.env.LLM_API_KEY  || process.env.GOOGLE_API_KEY || process.env.OPENROUTER_API_KEY,
  model:       process.env.LLM_MODEL    || 'gemini-3.1-flash-lite',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS || 1500),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS || 30000),
};

let _systemPrompt, _userTemplate;
async function loadPrompts() {
  if (!_systemPrompt)  _systemPrompt  = await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  if (!_userTemplate)  _userTemplate  = await readFile(USER_PROMPT_PATH,   'utf8');
  return { system: _systemPrompt, userTemplate: _userTemplate };
}

function buildFeedbackMessage(validation) {
  const lines = ['Your previous output had these problems. Rewrite the entire JSON without them.'];
  const banned = (validation.banned || []);
  if (banned.length) {
    lines.push('');
    lines.push(`Banned phrases you used: ${banned.map(b => `"${b}"`).join(', ')}`);
    lines.push('Permitted substitutions:');
    for (const [from, to] of FEEDBACK_SUBSTITUTIONS) {
      lines.push(`  - ${from} → ${to}`);
    }
  }
  const struct = (validation.structural || []);
  if (struct.length) {
    lines.push('');
    lines.push('Structural problems detected — these need active rewriting, not just word swaps:');
    for (const s of struct) {
      lines.push(`  - ${s.name}: ${s.evidence}`);
      // Per-rule remediation hints. The validator only flags; the LLM needs to know what to do.
      if (s.name === 'monotone_sentence_lengths') {
        lines.push('    FIX: Add at least one short sentence (6-12 words) AND one long sentence (20-30 words) inside "the_full_read". Even better, add a single-sentence paragraph or fragment for emphasis: "Not yet." / "Hardly." / "Three quarters in a row." This single change is the most reliable way to break monotone.');
      } else if (s.name === 'em_dash_overuse') {
        lines.push('    FIX: Replace em-dashes with commas, parentheses, or periods. Keep at MOST one em-dash in the entire piece — use it only when the pause is rhetorically essential. The em-dash-as-comma-substitute is the #1 AI signature.');
      } else if (s.name === 'negative_parallelism' || s.name === 'em_dashed_parallelism') {
        lines.push('    FIX: Delete the "not just X, but Y" construction entirely. Pick one — say only what is true. Do not rephrase with synonyms.');
      } else if (s.name === 'sentence_opening_adverb') {
        lines.push('    FIX: Strip the opening adverb ("Notably,", "Importantly,", "Crucially,"). If the claim needed emphasis, the sentence should carry it without the adverb.');
      } else if (s.name === 'summary_close') {
        lines.push('    FIX: Delete the wrap word ("Overall,", "In conclusion,", "In essence,"). End the piece on the verdict itself, not on a recap of it.');
      } else if (s.name === 'three_adjective_list') {
        lines.push('    FIX: Replace the three-adjective list with a specific characterisation. "Robust, scalable, and intuitive" → name the metric that proves the claim.');
      }
    }
  }
  const fab = validation.fabricated || [];
  if (fab.length) {
    lines.push('');
    lines.push(`Numbers in your output that do not appear in the source: ${fab.join(', ')}`);
    lines.push('Use only numbers verbatim from the news_summary or rationale. If a number you cited is wrong, remove it or replace with the correct one from the source.');
  }
  const issues = (validation.issues || []).filter(i => !i.startsWith('banned') && !i.startsWith('fabricated') && !i.startsWith('structural'));
  if (issues.length) {
    lines.push('');
    lines.push(`Schema issues: ${issues.join(', ')}`);
  }
  lines.push('');
  lines.push('Return the corrected JSON object. Same schema as before. No commentary outside the JSON.');
  return lines.join('\n');
}

function buildUserMessage(template, raw) {
  // news_summary is now the primary input. Falls back to rationale if absent.
  // The rationale is included as supporting context but explicitly flagged as containing
  // scoring-system meta-commentary the model should ignore.
  const newsSummary = (raw.news_summary || '').slice(0, 4000);
  const rationale = (raw.rationale || '').slice(0, 4000);
  return template
    .replace('{company}',        raw.company || '?')
    .replace('{symbol}',         raw.symbol || '?')
    .replace('{event_category}', raw.event_category_raw || '?')
    .replace('{event_type}',     raw.event_type || '?')
    .replace('{sentiment}',      raw.sentiment || '(blank)')
    .replace('{score}',          String(raw.score ?? '?'))
    .replace('{news_summary}',   newsSummary || '(no news summary provided — use rationale only)')
    .replace('{rationale}',      rationale || '(no rationale)');
}

export async function enrich(raw, previousAttempt = null) {
  if (!CFG.apiKey) return { ok: false, error: 'missing API key (set LLM_API_KEY or OPENROUTER_API_KEY)' };
  const { system, userTemplate } = await loadPrompts();
  const userMsg = buildUserMessage(userTemplate, raw);

  // Compose messages. If we have a previous attempt with issues, append it as a feedback turn.
  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: userMsg },
  ];
  if (previousAttempt?.parsed && previousAttempt?.validation?.issues?.length) {
    messages.push(
      { role: 'assistant', content: JSON.stringify(previousAttempt.parsed) },
      { role: 'user', content: buildFeedbackMessage(previousAttempt.validation) },
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${CFG.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${CFG.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://filings.local',
        'X-Title': 'Tipsheet pipeline',
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
    // Robust JSON extraction
    const start = content.indexOf('{');
    const end   = content.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no_json', raw_text: content.slice(0, 300), elapsed_ms };
    const stripped = content.slice(start, end + 1);
    let parsed;
    try { parsed = JSON.parse(stripped); }
    catch (e) { return { ok: false, error: 'json_parse', raw_error: e.message, raw_text: stripped.slice(0, 300), elapsed_ms }; }

    const v = validate(parsed, raw);
    return {
      ok: v.ok,
      parsed,
      validation: v,
      model: CFG.model,
      promptVersion: PROMPT_VERSION,
      usage: body.usage || null,
      elapsed_ms,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, elapsed_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ─── validation ─────────────────────────────────────────────────────

function validate(parsed, raw) {
  const issues = [];
  if (typeof parsed.headline !== 'string') issues.push('headline_missing');
  else if (parsed.headline.length > 85) issues.push(`headline_too_long:${parsed.headline.length}`);
  if (typeof parsed.dek !== 'string') issues.push('dek_missing');
  else if (parsed.dek.length > 240) issues.push(`dek_too_long:${parsed.dek.length}`);
  if (!parsed.the_number?.value) issues.push('the_number_missing');
  if (!Array.isArray(parsed.whats_new) || parsed.whats_new.length === 0) issues.push('whats_new_empty');
  if (typeof parsed.why_it_matters !== 'string' || parsed.why_it_matters.length < 30) issues.push('why_it_matters_thin');
  if (!Array.isArray(parsed.what_were_watching) || parsed.what_were_watching.length === 0) issues.push('what_were_watching_empty');
  if (typeof parsed.the_full_read !== 'string') issues.push('the_full_read_missing');
  else if (parsed.the_full_read.length < 200) issues.push(`the_full_read_thin:${parsed.the_full_read.length}`);
  else if (parsed.the_full_read.length > 1500) issues.push(`the_full_read_too_long:${parsed.the_full_read.length}`);
  if (typeof parsed.canonical_category !== 'string') issues.push('category_missing');
  if (typeof parsed.sector !== 'string') issues.push('sector_missing');
  const validTones = new Set(['Adverse', 'Strained', 'Uncertain', 'Routine', 'Constructive', 'Catalytic']);
  if (!parsed.editorial_tone || typeof parsed.editorial_tone !== 'object') issues.push('tone_missing');
  else {
    if (!validTones.has(parsed.editorial_tone.label)) issues.push('tone_label_invalid');
    if (!Number.isFinite(Number(parsed.editorial_tone.score))) issues.push('tone_score_missing');
    else if (Number(parsed.editorial_tone.score) < 0 || Number(parsed.editorial_tone.score) > 100) issues.push('tone_score_range');
    if (!['Low', 'Medium', 'High'].includes(parsed.editorial_tone.confidence)) issues.push('tone_confidence_invalid');
    if (typeof parsed.editorial_tone.reason !== 'string' || parsed.editorial_tone.reason.length < 20) issues.push('tone_reason_thin');
    else if (parsed.editorial_tone.reason.length > 180) issues.push(`tone_reason_too_long:${parsed.editorial_tone.reason.length}`);
  }

  // Assembled prose for layer-1 + layer-2 checks
  const proseText = [
    parsed.headline, parsed.dek,
    ...(parsed.whats_new || []),
    parsed.why_it_matters,
    ...(parsed.what_were_watching || []),
    parsed.the_full_read,
  ].filter(Boolean).join(' ');

  // Layer 1 — phrase patterns
  const banned = [];
  for (const pat of PHRASE_PATTERNS) {
    const m = proseText.match(pat);
    if (m) banned.push(m[0]);
  }
  if (banned.length) issues.push(`banned:${banned.slice(0, 5).join('|')}`);

  // Layer 2 — structural rules (em-dash overuse, parallelism, burstiness, etc.)
  const structural = [];
  for (const rule of STRUCTURAL_RULES) {
    const hit = rule(proseText, { full_read: parsed.the_full_read });
    if (hit) structural.push(hit);
  }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  // Layer 3 — number fidelity (source is now news_summary + rationale + identity)
  const src = (raw.news_summary || '') + ' ' + (raw.rationale || '') + ' ' + (raw.company || '') + ' ' + (raw.symbol || '');
  const srcNums = sourceFingerprint(src);
  const outNums = numberFingerprint(proseText + ' ' + (parsed.the_number?.value || '') + ' ' + (parsed.the_number?.label || ''));
  const srcNumArr = [...srcNums];
  const fabricated = [...outNums].filter(n => {
    if (n.length < 3) return false;
    if (srcNums.has(n)) return false;
    for (const s of srcNumArr) {
      if (s.startsWith(n)) return false;
      if (n.startsWith(s) && n.length - s.length <= 1) return false;
    }
    return true;
  });
  if (fabricated.length) issues.push(`fabricated:${fabricated.slice(0, 5).join(',')}`);

  return { ok: issues.length === 0, issues, fabricated, banned, structural };
}

function numberFingerprint(text) {
  if (!text) return new Set();
  const matches = String(text).match(/\d[\d,.]*/g) || [];
  const out = new Set();
  for (const m of matches) {
    const n = m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, '');
    if (n) out.add(n);
  }
  return out;
}

function sourceFingerprint(text) {
  const base = numberFingerprint(text);
  for (const m of (String(text).match(/FY[\s-]?(\d{2,4})/gi) || [])) {
    const yy = m.replace(/\D/g, '');
    if (yy.length === 2) base.add('20' + yy);
    base.add(yy);
  }
  return base;
}
