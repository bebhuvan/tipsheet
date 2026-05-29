// Radar item enrichment via LLM. Writes the "why_now" line per radar entry.
// Reuses the same OpenAI-compatible endpoint as enricher.mjs, and the same
// banned-phrase / structural validators so voice stays consistent across the
// publication. Validation failure triggers one feedback retry; persistent
// failure leaves the templated why_now in place and marks the row as 'failed'.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASE_PATTERNS } from './banned-patterns.mjs';
import { compatHeaders, tokenParam } from './llm-compat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = resolve(__dirname, 'prompts/radar_system.txt');
const USER_PROMPT_PATH   = resolve(__dirname, 'prompts/radar_user.txt');
export const RADAR_PROMPT_VERSION = 'radar-why-now.v4';

const CFG = {
  baseUrl:     process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey:      process.env.LLM_API_KEY  || process.env.GOOGLE_API_KEY || process.env.OPENROUTER_API_KEY || process.env.DEEPSEEK_API_KEY,
  model:       process.env.RADAR_LLM_MODEL || process.env.LLM_MODEL || 'gemini-3.1-flash-lite',
  maxTokens:   Number(process.env.RADAR_LLM_MAX_TOKENS || 400),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS || 30000),
};

const TRIGGER_LABELS = {
  filing_cluster:   'Filing cluster',
  order_win:        'Order flow',
  smart_money:      'Ownership',
  concall_watch:    'Call watch',
  quality_breakout: 'Quality overlap',
};

let _systemPrompt, _userTemplate;
async function loadPrompts() {
  if (!_systemPrompt) _systemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  if (!_userTemplate) _userTemplate = await readFile(USER_PROMPT_PATH,   'utf8');
  return { system: _systemPrompt, userTemplate: _userTemplate };
}

function fmtCr(n) {
  if (n == null) return '—';
  if (n >= 100000) return `₹${(n / 100000).toFixed(2)} lakh cr`;
  return `₹${Number(n).toLocaleString('en-IN')} cr`;
}

function fmtEvidence(rows) {
  if (!rows || rows.length === 0) return '(none)';
  return rows.slice(0, 5).map(r => {
    const date = String(r.created_on || '').slice(0, 10) || '—';
    const cat = r.canonical_category || r.event_category_canonical || r.event_type || 'Other';
    const headline = r.headline || r.event_type || '(no headline)';
    const dek = r.dek ? `\n  dek: "${String(r.dek).replace(/\s+/g, ' ').slice(0, 220)}"` : '';
    return `- ${date} · ${cat} · "${String(headline).replace(/"/g, '\\"')}"${dek}`;
  }).join('\n');
}

function buildUserMessage(template, item, evidenceRows) {
  return template
    .replace('{company}',       item.company || item.symbol || '?')
    .replace('{symbol}',        item.symbol || '?')
    .replace('{sector}',        item.sector || '(unknown)')
    .replace('{market_cap}',    fmtCr(item.market_cap))
    .replace('{trigger_type}',  item.trigger_type || '?')
    .replace('{trigger_label}', TRIGGER_LABELS[item.trigger_type] || item.trigger_type || '?')
    .replace('{quality_flags}', (item.quality_flags || []).join('; ') || '(none)')
    .replace('{risk_flags}',    (item.risk_flags || []).join('; ') || '(none)')
    .replace('{evidence_block}', fmtEvidence(evidenceRows));
}

function buildFeedback(issues) {
  const lines = ['Your previous output had these problems. Rewrite the why_now line without them.'];
  for (const i of issues) lines.push(`  - ${i}`);
  lines.push('');
  lines.push('Return the same JSON shape ({"why_now": "..."}). No commentary.');
  return lines.join('\n');
}

// ─── validation ─────────────────────────────────────────────────────

const SUMMARY_CLOSE = /(?:^|\.\s+)(In conclusion|In essence|In summary|Overall|Ultimately|All in all|To sum up|To conclude)\b/i;
const OPEN_ADVERB = /^(Notably|Importantly|Crucially|Ultimately|Predictably|Tellingly|Strikingly|Interestingly|Indeed),/i;
const NEG_PARALLEL = /\bnot (?:just|only|merely|simply)[^.\n]{1,80}\bbut(?: also)?\b/i;
const TRIGGER_VOCAB = /\b(filing(?:s)? (?:activity )?cluster|order flow signal|ownership signal|quality overlap signal|call[- ]watch signal)\b/i;
const FORWARD_ATTRIB = /\b(?:investors|the market|analysts|the street|shareholders) (?:will|should|expect|believe|think|are watching)\b/i;

// AI-writing tells — syntactic patterns that survive paraphrase.
const BRIDGE_FILLER = /\b(?:alongside\b|in addition,|while at the same time\b|in turn,|to that end,|to round out\b|in the process,|on top of\b|coupled with\b|combined with\b)/i;
const EVENT_VERB_FILLER = /\b(?:marks|represents|signals|points to|demonstrates|indicates|translates to|amounts to|speaks to)\b/i;
const HEDGE = /\b(?:appears to|seems to|tends to|looks like|may well|is likely to|could be seen as)\b/i;
const META_LANGUAGE = /\b(?:worth a closer look|worth noting|the standout|the takeaway|what makes this interesting|the key thing|of note)\b/i;
const OPENER_CLICHE = /^(?:On paper|On the surface|At first glance|Setting aside|It's worth|It is worth|Among the takeaways)\b/i;
// Second-reference "the firm/group/entity/issuer" used as a subject — except
// where a role or org modifier follows (e.g. "the group's CFO", "the firm's auditor").
const SECOND_REF_HEDGE = /\bthe (?:firm|group|entity|issuer)\b(?!['\s]+(?:CFO|CEO|chairman|founder|board|auditor|management|directors|operations|subsidiary|subsidiaries))/i;
// The original "Company has X. With/Despite Y, the open question is whether Z" template.
const TEMPLATE_COLLAPSE_V1 = /^[A-Z][\w &'.-]+? (?:has|booked|posted|secured) [^.]+\.\s+(?:With|Despite) [^.]+,\s+the open question is whether\b/i;
// The substitute template the model fell onto: "While/Despite/Although [X], [Y]. Whether [Z] is the next test/move/question."
const TEMPLATE_COLLAPSE_V2 = /^[^.]+\.\s+(?:While|Despite|Although|Even as)\b[^.]+\.\s+Whether\b[^.]*\bis\s+the\b/i;
// "While" as a subordinator at the start of a clause: banned outright.
const WHILE_SUBORDINATOR = /\bwhile\s+(?:[a-z]|the\s|its\s|management\s|profit\s|revenue\s|FY|Q[1-4]|H[12])/i;
// "Whether [X] is the [Y]" — banned in ALL forms. The model keeps finding new Y
// values (issue, test, question, core issue, technical challenge, real question).
// Rather than chase every substitution, ban the structure.
const WHETHER_IS_THE = /\bwhether\b[^.]{3,140}\bis\s+the\b/i;
// "Whether [X] will/can decide/determine/tell..." — same template, "will" instead of "is".
const WHETHER_WILL_DECIDE = /\bwhether\b[^.]{3,140}\b(?:will|can|might)\s+(?:decide|determine|tell|settle|drive|dictate|prove)\b/i;
const CLOSING_REMAINS = /\b(?:it remains to be seen|time will tell|all eyes are on)\b/i;

export function validateRadarWhyNow(text) {
  const issues = [];
  if (typeof text !== 'string') {
    return { ok: false, issues: ['why_now is not a string'] };
  }
  if (text.trim() === 'INSUFFICIENT_EVIDENCE') {
    return { ok: true, issues: [], escape: true };
  }
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 30) issues.push(`too short: ${words} words (min 30)`);
  if (words > 80) issues.push(`too long: ${words} words (max 65, allowing 80 before hard reject)`);

  const emDashes = (t.match(/—/g) || []).length;
  if (emDashes > 1) issues.push(`${emDashes} em-dashes (max 1)`);

  for (const re of PHRASE_PATTERNS) {
    const m = t.match(re);
    if (m) { issues.push(`banned phrase: "${m[0]}"`); break; }
  }
  if (NEG_PARALLEL.test(t))     issues.push(`negative parallelism ("not just X, but Y")`);
  if (TRIGGER_VOCAB.test(t))    issues.push(`trigger label repeated in prose (e.g. "filing activity cluster")`);
  if (FORWARD_ATTRIB.test(t))   issues.push(`unsourced attribution to investors/market/analysts`);
  if (OPEN_ADVERB.test(t))      issues.push(`opens with banned adverb`);
  if (SUMMARY_CLOSE.test(t))    issues.push(`summary close ("Overall", "In conclusion", ...)`);

  // AI-tell patterns
  const bridge = t.match(BRIDGE_FILLER);
  if (bridge) issues.push(`bridge-clause filler: "${bridge[0]}"`);
  const evVerb = t.match(EVENT_VERB_FILLER);
  if (evVerb) issues.push(`event-verb filler: "${evVerb[0]}" — use plain "is" or a concrete verb`);
  const hedge = t.match(HEDGE);
  if (hedge) issues.push(`hedge phrase: "${hedge[0]}"`);
  const meta = t.match(META_LANGUAGE);
  if (meta) issues.push(`meta-language echo: "${meta[0]}"`);
  if (OPENER_CLICHE.test(t))    issues.push(`opener cliché ("On paper", "At first glance", ...)`);
  const secondRef = t.match(SECOND_REF_HEDGE);
  if (secondRef) issues.push(`second-reference hedge: "${secondRef[0]}" — use the company name or a pronoun`);
  if (TEMPLATE_COLLAPSE_V1.test(t)) issues.push(`template collapse v1: "[Company] has X. With/Despite Y, the open question is whether Z." — rewrite with two short sentences or a four-sentence structure`);
  if (TEMPLATE_COLLAPSE_V2.test(t)) issues.push(`template collapse v2: "[Lede]. While/Despite [Y], [Z]. Whether [W] is the [next test/move/question]." — same template with substituted vocabulary. Rewrite without "while" and without "Whether ... is the next ...".`);
  if (WHILE_SUBORDINATOR.test(t)) issues.push(`"while" used as a subordinator — banned outright. Use a period and two sentences instead.`);
  if (WHETHER_IS_THE.test(t)) issues.push(`"Whether [X] is the [Y]" closer structure — banned regardless of Y (test, move, question, issue, challenge, etc.). Rotate to a bare declarative ("Margins are flat."), a flipped subject ("The cash question is unanswered."), or no closer at all.`);
  if (WHETHER_WILL_DECIDE.test(t)) issues.push(`"Whether [X] will decide/determine/tell..." closer — same template, different verb. Banned. Use a different structure.`);
  if (CLOSING_REMAINS.test(t))  issues.push(`closer cliché ("it remains to be seen", "time will tell", "all eyes are on")`);

  return { ok: issues.length === 0, issues };
}

// ─── single-call enrichment ────────────────────────────────────────

async function callLLM(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${CFG.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        ...compatHeaders(CFG.baseUrl, CFG.apiKey),
        'HTTP-Referer': 'https://filings.local',
        'X-Title': 'Filings Radar enricher',
      },
      body: JSON.stringify({
        model: CFG.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: CFG.temperature,
        ...tokenParam(CFG.baseUrl, CFG.maxTokens),
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
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return { ok: false, error: 'no_json', raw_text: content.slice(0, 300), elapsed_ms };
    }
    let parsed;
    try { parsed = JSON.parse(content.slice(start, end + 1)); }
    catch (e) { return { ok: false, error: 'json_parse', raw_error: e.message, elapsed_ms }; }
    return { ok: true, parsed, usage: body.usage || null, elapsed_ms };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, elapsed_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function enrichRadarItem(item, evidenceRows) {
  if (!CFG.apiKey) {
    return { ok: false, error: 'missing API key (set LLM_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, or DEEPSEEK_API_KEY)' };
  }
  const { system, userTemplate } = await loadPrompts();
  const userMsg = buildUserMessage(userTemplate, item, evidenceRows);

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: userMsg },
  ];

  // First attempt
  let r = await callLLM(messages);
  if (!r.ok) return { ok: false, error: r.error, raw_error: r.raw_error, elapsed_ms: r.elapsed_ms };

  let whyNow = r.parsed?.why_now;
  let validation = validateRadarWhyNow(whyNow);

  // One feedback retry on validation failure (skip if it returned INSUFFICIENT_EVIDENCE)
  if (!validation.ok && !validation.escape) {
    const retryMessages = [
      ...messages,
      { role: 'assistant', content: JSON.stringify({ why_now: whyNow }) },
      { role: 'user', content: buildFeedback(validation.issues) },
    ];
    const r2 = await callLLM(retryMessages);
    if (r2.ok) {
      whyNow = r2.parsed?.why_now;
      validation = validateRadarWhyNow(whyNow);
      r = r2;
    }
  }

  if (!validation.ok) {
    return {
      ok: false,
      error: 'validation_failed',
      issues: validation.issues,
      why_now: whyNow,
      elapsed_ms: r.elapsed_ms,
      usage: r.usage,
    };
  }

  return {
    ok: true,
    why_now: validation.escape ? null : whyNow.trim(),
    escape: !!validation.escape,
    model: CFG.model,
    prompt_version: RADAR_PROMPT_VERSION,
    usage: r.usage,
    elapsed_ms: r.elapsed_ms,
  };
}
