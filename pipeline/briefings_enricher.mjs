// Briefings enricher: generates The Open / The Close twice-daily editorial digests.
//
// Pulls inputs from:
//   - filings_enriched (top by score in the last 24h)
//   - concalls_enriched (recent mgmt-consistency flags)
//   - macro_calendar (today's India + high-impact global events)
//   - market_snapshots (Nifty breadth indices, plus sectoral indices for context)
//
// Composes a single LLM call with structured input, validates output against the same
// validator used for filings (PHRASE_PATTERNS + STRUCTURAL_RULES).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES } from './banned-patterns.mjs';
import { compatHeaders, tokenParam } from './llm-compat.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PATH = resolve(__dirname, 'prompts/briefings_system.txt');
const USER_PATH   = resolve(__dirname, 'prompts/briefings_user.txt');
export const BRIEFING_PROMPT_VERSION = 'briefing.v6';

const CFG = {
  baseUrl:     process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
  apiKey:      process.env.LLM_API_KEY  || process.env.GOOGLE_API_KEY,
  model:       process.env.LLM_MODEL    || 'gemini-3.1-flash-lite',
  maxTokens:   Number(process.env.LLM_MAX_TOKENS_BRIEFING || 5200),
  temperature: Number(process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.LLM_TIMEOUT_MS_BRIEFING || process.env.LLM_TIMEOUT_MS || 45000),
};

const FALLBACK_CFG = {
  baseUrl:     process.env.BRIEFING_FALLBACK_LLM_BASE_URL || process.env.LLM_FALLBACK_BASE_URL || '',
  apiKey:      process.env.BRIEFING_FALLBACK_LLM_API_KEY  || process.env.LLM_FALLBACK_API_KEY  || '',
  model:       process.env.BRIEFING_FALLBACK_LLM_MODEL    || process.env.LLM_FALLBACK_MODEL    || '',
  maxTokens:   Number(process.env.BRIEFING_FALLBACK_LLM_MAX_TOKENS || process.env.LLM_MAX_TOKENS_BRIEFING || 5200),
  temperature: Number(process.env.BRIEFING_FALLBACK_LLM_TEMPERATURE || process.env.LLM_TEMPERATURE || 1.0),
  timeoutMs:   Number(process.env.BRIEFING_FALLBACK_LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS_BRIEFING || process.env.LLM_TIMEOUT_MS || 45000),
};

function hasFallbackCfg() {
  return Boolean(FALLBACK_CFG.baseUrl && FALLBACK_CFG.apiKey && FALLBACK_CFG.model);
}

function shouldTryFallback(result) {
  if (result?.parsed) return false;
  const error = String(result?.error || '');
  return error === 'timeout' || /^HTTP (429|5\d\d)\b/.test(error);
}

let _system, _user;
async function loadPrompts() {
  if (!_system) _system = await readFile(SYSTEM_PATH, 'utf8');
  if (!_user)   _user   = await readFile(USER_PATH,   'utf8');
  return { system: _system, userTemplate: _user };
}

/**
 * Gather all input data the LLM needs. Caller passes the open DB handle.
 *
 * @param db better-sqlite3 Database
 * @param type 'open' | 'close'
 * @param dateYmd YYYY-MM-DD (IST)
 * @param windowHours how far back to pull filings (default 30)
 */
export function gatherBriefingInputs(db, type, dateYmd, { windowHours = 30 } = {}) {
  // Top filings in the last N hours
  const cutoff = new Date(dateYmd + 'T00:00:00+05:30');
  cutoff.setHours(cutoff.getHours() - windowHours);
  const cutoffIso = cutoff.toISOString().replace('T', ' ').slice(0, 19);

  const topFilings = db.prepare(`
    SELECT r.record_id, r.symbol, r.company, r.score, r.event_type,
           r.event_category_canonical AS category, r.created_on,
           e.headline, e.dek, e.the_number_value, e.the_number_label, e.why_it_matters,
           f.sector, f.market_cap, f.pe, f.roe, f.debt_to_equity,
           f.revenue_growth, f.pat_growth
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    LEFT JOIN fundamentals f ON f.symbol = r.symbol
    WHERE e.validation_ok = 1 AND r.created_on >= ?
    ORDER BY r.score DESC, r.created_on DESC
    LIMIT 32
  `).all(cutoffIso);

  attachPriorFilingContext(db, topFilings);

  // Recent mgmt-consistency flags (last 7 days)
  const concallCutoff = new Date(dateYmd + 'T00:00:00+05:30');
  concallCutoff.setDate(concallCutoff.getDate() - 7);
  const concallCutoffIso = concallCutoff.toISOString();
  const mgmtFlags = db.prepare(`
    SELECT c.isin, c.symbol, c.company_name, c.event_time,
           e.headline, e.inconsistency_flag, e.the_take
    FROM concalls_raw c JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE e.validation_ok = 1 AND e.inconsistency_flag IS NOT NULL AND e.inconsistency_flag != ''
      AND c.event_time >= ?
    ORDER BY c.event_time DESC LIMIT 3
  `).all(concallCutoffIso);

  const recentConcalls = db.prepare(`
    SELECT c.symbol, c.company_name, c.sector, c.event_time,
           e.headline, e.dek, e.the_take, e.inconsistency_flag,
           e.whats_new, e.themes, e.guidance_watch, e.risk_flags, e.key_quotes, e.the_brief
    FROM concalls_raw c JOIN concalls_enriched e ON e.isin = c.isin AND e.event_time = c.event_time
    WHERE e.validation_ok = 1 AND c.event_time >= ?
    ORDER BY c.event_time DESC
    LIMIT 8
  `).all(concallCutoffIso);

  // Macro events scheduled for today (India + high-impact global)
  const macroEvents = db.prepare(`
    SELECT date, country_code, coverage, indicator, period, previous_val, forecast_val, actual_val,
           category, unit, impact
    FROM macro_calendar
    WHERE substr(date, 1, 10) = ?
      AND (country_code = 'IN' OR impact = 'H')
    ORDER BY (country_code = 'IN') DESC, impact ASC, date ASC
    LIMIT 8
  `).all(dateYmd);

  // Market snapshot — breadth ladder first. Nifty Indices classifies Total Market,
  // Nifty 500, Midcap 150, Smallcap 250 and Microcap 250 under broad-based indices.
  const marketRows = db.prepare(`
    SELECT s.symbol, s.name, s.price, s.change_abs, s.change_pct, s.prev_close
    FROM market_snapshots s
    INNER JOIN (
      SELECT symbol, MAX(fetched_at) AS max_t FROM market_snapshots
      WHERE symbol IN ('NIFTY_500.NS', 'NIFTY_MIDCAP_150.NS', 'NIFTY_SMLCAP_250.NS', 'NIFTY_MICROCAP250.NS')
      GROUP BY symbol
    ) latest ON latest.symbol = s.symbol AND latest.max_t = s.fetched_at
  `).all();

  return {
    type, date: dateYmd, window_hours: windowHours,
    top_filings: topFilings,
    recent_concall_notes: recentConcalls,
    mgmt_consistency_flags: mgmtFlags,
    macro_events_today: macroEvents,
    market_snapshot: marketRows,
  };
}

function attachPriorFilingContext(db, rows) {
  if (!rows.length) return rows;
  const stmt = db.prepare(`
    SELECT r.record_id, r.created_on, r.event_category_canonical AS category,
           e.headline, e.dek, e.the_number_value, e.the_number_label, e.why_it_matters
    FROM filings_raw r
    JOIN filings_enriched e ON e.record_id = r.record_id
    WHERE e.validation_ok = 1
      AND r.symbol = ?
      AND r.record_id != ?
      AND r.created_on < ?
    ORDER BY r.created_on DESC
    LIMIT 5
  `);
  for (const row of rows) {
    row.prior_notes = row.symbol && row.created_on
      ? stmt.all(row.symbol, row.record_id, row.created_on)
      : [];
  }
  return rows;
}

function renderTopFilings(rows) {
  if (!rows.length) return '(none)';
  const fmt = (value, suffix = '') => value == null ? 'n/a' : `${value}${suffix}`;
  const capTier = (marketCap) => {
    const v = Number(marketCap);
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v >= 100000) return 'mega cap';
    if (v >= 20000) return 'large cap';
    if (v >= 5000) return 'mid cap';
    if (v >= 1000) return 'small cap';
    return 'micro cap';
  };
  return rows.map(r => {
    const financial = [
      r.sector ? `sector ${r.sector}` : null,
      capTier(r.market_cap) ? `size ${capTier(r.market_cap)}` : null,
      r.market_cap != null ? `market cap ₹${Number(r.market_cap).toLocaleString('en-IN')} cr` : null,
      r.pe != null ? `P/E ${r.pe}x` : null,
      r.roe != null ? `ROE ${r.roe}%` : null,
      r.debt_to_equity != null ? `debt/equity ${r.debt_to_equity}x` : null,
      r.revenue_growth != null ? `revenue growth ${fmt(r.revenue_growth, '%')}` : null,
      r.pat_growth != null ? `PAT growth ${fmt(r.pat_growth, '%')}` : null,
    ].filter(Boolean).join(' · ');
    const prior = (r.prior_notes || []).map(p => {
      const number = p.the_number_value ? ` · ${p.the_number_value}${p.the_number_label ? ` (${p.the_number_label})` : ''}` : '';
      const why = p.why_it_matters ? `\n      Why then: ${p.why_it_matters}` : '';
      return `    - ${String(p.created_on || '').slice(0, 10)} · ${p.category || 'Other'} · ${p.headline || p.dek || ''}${number}${why}`;
    }).join('\n');
    return `[filing_id ${r.record_id}] ${r.symbol || '?'} · ${r.company || ''} · score ${r.score} · ${r.category}\n  Sector/cap: ${[r.sector, capTier(r.market_cap)].filter(Boolean).join(' · ') || 'n/a'}\n  Headline: ${r.headline}\n  Number: ${r.the_number_value || ''} (${r.the_number_label || ''})\n  Financial context: ${financial || 'n/a'}\n  Why: ${r.why_it_matters || ''}\n  Prior Tipsheet context for this company:\n${prior || '    - none in archive'}`;
  }).join('\n\n');
}
function renderRecentConcallNotes(rows) {
  if (!rows.length) return '(none)';
  const parse = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  return rows.map(r => {
    const bullets = parse(r.whats_new).slice(0, 4).map(x => `    - ${x}`).join('\n');
    const themes = parse(r.themes).slice(0, 3).map(x => {
      if (typeof x === 'string') return `    - ${x}`;
      return `    - ${x.label || 'Theme'}: ${x.detail || x.value || ''}`;
    }).join('\n');
    const guidance = parse(r.guidance_watch).slice(0, 3).map(x => `    - ${x}`).join('\n');
    const risks = parse(r.risk_flags).slice(0, 3).map(x => `    - ${x}`).join('\n');
    const quotes = parse(r.key_quotes).slice(0, 2).map(q => `    - "${q.quote}" — ${q.attribution || 'management'}`).join('\n');
    return `- ${r.company_name} (${r.symbol || '?'}) · ${String(r.event_time).slice(0,10)} · ${r.sector || 'n/a'}\n  Headline: ${r.headline || ''}\n  Dek: ${r.dek || ''}\n  Take: ${r.the_take || ''}\n  Consistency flag: ${r.inconsistency_flag || 'none'}\n  Themes:\n${themes || '    - n/a'}\n  Guidance watch:\n${guidance || '    - n/a'}\n  Risk flags:\n${risks || '    - n/a'}\n  What's new:\n${bullets || '    - n/a'}\n  Quotes:\n${quotes || '    - n/a'}`;
  }).join('\n\n');
}
function renderMgmtFlags(rows) {
  if (!rows.length) return '(none)';
  return rows.map(r =>
    `- ${r.company_name} (${r.symbol || '?'}) · ${r.event_time.slice(0,10)}\n  Flag: ${r.inconsistency_flag}\n  Take: ${r.the_take || ''}\n  URL: /concalls/${String(r.symbol||'').toLowerCase()}/${r.event_time.slice(0,10)}/`
  ).join('\n\n');
}
function renderMacroEvents(rows) {
  if (!rows.length) return '(none scheduled)';
  return rows.map(e => {
    const parts = [`${e.country_code || '??'} · ${e.indicator}`];
    if (e.previous_val != null) parts.push(`prev ${e.previous_val}${e.unit ? ' '+e.unit : ''}`);
    if (e.forecast_val != null) parts.push(`fcst ${e.forecast_val}${e.unit ? ' '+e.unit : ''}`);
    if (e.actual_val != null)   parts.push(`actual ${e.actual_val}${e.unit ? ' '+e.unit : ''}`);
    parts.push(`impact ${e.impact || '?'}`);
    return '- ' + parts.join(' · ');
  }).join('\n');
}
function renderMarketSnapshot(rows) {
  if (!rows.length) return '(market data not available)';
  return rows.map(r => {
    const pct = r.change_pct == null ? '—' : `${r.change_pct > 0 ? '+' : ''}${r.change_pct.toFixed(2)}%`;
    return `- ${r.name || r.symbol}: ${r.price?.toFixed(2) || '?'} (${pct}, prev ${r.prev_close?.toFixed(2) || '?'})`;
  }).join('\n');
}

function buildUserMessage(template, inputs) {
  return template
    .replace('{briefing_type}', inputs.type)
    .replace('{date}',          inputs.date)
    .replace('{window_hours}',  String(inputs.window_hours))
    .replace('{market_snapshot}',          renderMarketSnapshot(inputs.market_snapshot))
    .replace('{top_filings}',              renderTopFilings(inputs.top_filings))
    .replace('{recent_concall_notes}',      renderRecentConcallNotes(inputs.recent_concall_notes || []))
    .replace('{mgmt_consistency_flags}',   renderMgmtFlags(inputs.mgmt_consistency_flags))
    .replace('{macro_events_today}',       renderMacroEvents(inputs.macro_events_today));
}

function extractFirstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const BRIEFING_STYLE_REWRITES = [
  [/\bunderscor(e|es|ed|ing)\b/gi, 'shows'],
  [/\bhighlight(s|ed|ing)?\b(?!\s+reel)/gi, 'flags'],
  [/\bshowcas(e|es|ed|ing)\b/gi, 'shows'],
  [/\bemphasi[sz](e|es|ed|ing)\b/gi, 'stresses'],
  [/\bspeaks? to (?:the|a) /gi, 'points to '],
  [/\b(?:stands?|serves?|functions?|acts?) as (a|an|the) ([a-z]+)/gi, 'is $1 $2'],
  [/\bmoreover,?\s*/gi, 'Also, '],
  [/\bfurthermore,?\s*/gi, 'Also, '],
  [/\badditionally,?\s*/gi, 'Also, '],
  [/\bconsequently,?\s*/gi, 'So '],
  [/\bsubsequently,?\s*/gi, 'Then '],
  [/\bnevertheless,?\s*/gi, 'Still, '],
  [/\bnonetheless,?\s*/gi, 'Still, '],
  [/\bultimately,?\s*/gi, 'In the end, '],
  [/\boverall,?\s*/gi, 'Taken together, '],
  [/\bgoing forward\b/gi, 'from here'],
  [/\bmoving forward\b/gi, 'from here'],
  [/\bmargin expansion\b/gi, 'margin improvement'],
  [/\boperational momentum\b/gi, 'operating progress'],
  [/\boperational discipline\b/gi, 'cost control'],
  [/\bexecution discipline\b/gi, 'delivery control'],
  [/\bwell-positioned to\b/gi, 'has room to'],
  [/\bpoised to\b/gi, 'set to'],
  [/\bleverag(e|ing|es)\b/gi, 'use'],
  [/\brobust\b/gi, 'strong'],
  [/\bcrucial(ly)?\b/gi, 'important'],
  [/\bpivotal\b/gi, 'central'],
  [/\btransformative\b/gi, 'large'],
];

function repairBriefingText(text) {
  let next = String(text);
  for (const [pattern, replacement] of BRIEFING_STYLE_REWRITES) {
    next = next.replace(pattern, replacement);
  }
  next = next
    .replace(/\bAlso,\s+Also,\s+/g, 'Also, ')
    .replace(/\bIn the end,\s+In the end,\s+/g, 'In the end, ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return next;
}

function repairBriefingValue(value) {
  if (typeof value === 'string') return repairBriefingText(value);
  if (Array.isArray(value)) return value.map(repairBriefingValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repairBriefingValue(v)]));
  }
  return value;
}

export async function enrichBriefing(inputs, previousAttempt = null) {
  if (!CFG.apiKey) return { ok: false, error: 'missing API key' };
  const { system, userTemplate } = await loadPrompts();
  const userMsg = buildUserMessage(userTemplate, inputs);

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

  let result = await callBriefingModel(CFG, messages, inputs, userMsg);
  if (!result.ok && shouldTryFallback(result) && hasFallbackCfg()) {
    const fallback = await callBriefingModel(FALLBACK_CFG, messages, inputs, userMsg);
    if (fallback.parsed || fallback.ok) {
      return { ...fallback, fallback_from: result.error || 'primary_failed' };
    }
  }
  return result;
}

async function callBriefingModel(cfg, messages, inputs, userMsg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: compatHeaders(cfg.baseUrl, cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: cfg.temperature,
        ...tokenParam(cfg.baseUrl, cfg.maxTokens),
      }),
    });
    const elapsed_ms = Date.now() - t0;
    if (!r.ok) {
      const body = await r.text();
      return { ok: false, error: `HTTP ${r.status}`, raw_error: body.slice(0, 300), elapsed_ms };
    }
    const body = await r.json();
    const content = body.choices?.[0]?.message?.content ?? '';
    const json = extractFirstJsonObject(content);
    if (!json) return { ok: false, error: 'no_json', elapsed_ms };
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { return { ok: false, error: 'json_parse', raw_error: e.message, elapsed_ms }; }

    let v = validate(parsed, inputs);
    if (!v.ok && v.issues.some(i => i.startsWith('banned:') || i.startsWith('structural:'))) {
      const repaired = repairBriefingValue(parsed);
      const repairedValidation = validate(repaired, inputs);
      if (repairedValidation.ok || repairedValidation.issues.length <= v.issues.length) {
        parsed = repaired;
        v = repairedValidation;
      }
    }
    return {
      ok: v.ok, parsed, validation: v,
      model: cfg.model, promptVersion: BRIEFING_PROMPT_VERSION,
      usage: body.usage || null, elapsed_ms,
      user_message_sent: userMsg,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, elapsed_ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function buildFeedbackMessage(validation) {
  const lines = ['Your previous briefing had these problems. Rewrite the entire JSON without them.'];
  if (validation.eventIssues?.length) {
    lines.push('');
    lines.push('Event problems:');
    for (const e of validation.eventIssues) lines.push(`  - ${e}`);
    lines.push('  Each event needs a real filing_id from top_filings and 2-4 sentences of prose. Aim for 10-14 events when the input supports it.');
  }
  if (validation.banned?.length) {
    lines.push('');
    lines.push(`Banned phrases you used: ${validation.banned.map(b => `"${b}"`).join(', ')}`);
    lines.push('Substitutions:');
    lines.push('  - "underscore" / "highlight" / "showcase" / "emphasize" → name the human or the number ("Q3 sales of ₹420 cr show X").');
    lines.push('  - "leverage" → use, draw on, tap.');
    lines.push('  - "investors will" / "the market expects" → "the open question is" / "the next test is".');
    lines.push('  - "transformative" → describe what specifically changes.');
  }
  if (validation.structural?.length) {
    lines.push('');
    lines.push('Structural problems detected — these need active rewriting:');
    for (const s of validation.structural) {
      lines.push(`  - ${s.name}: ${s.evidence}`);
      if (s.name === 'monotone_sentence_lengths') {
        lines.push('    FIX: Mix short (6-12 word) and long (20-30 word) sentences. Add a single-sentence fragment for emphasis.');
      } else if (s.name === 'em_dash_overuse') {
        lines.push('    FIX: Replace em-dashes with commas, periods, or parentheses. Maximum one em-dash in the whole briefing.');
      }
    }
  }
  lines.push('');
  lines.push('Return the corrected JSON. Same schema. No commentary outside the JSON.');
  return lines.join('\n');
}

function validate(parsed, inputs) {
  const issues = [];
  if (typeof parsed?.headline !== 'string' || parsed.headline.length === 0) issues.push('headline_missing');
  else if (parsed.headline.length > 100) issues.push(`headline_too_long:${parsed.headline.length}`);
  if (typeof parsed?.dek !== 'string') issues.push('dek_missing');
  if (typeof parsed?.the_take !== 'string' || parsed.the_take.trim().length < 240) issues.push('the_take_thin');
  if (typeof parsed?.the_take === 'string' && parsed.the_take.length > 1200) issues.push(`the_take_too_long:${parsed.the_take.length}`);

  // Events: must reference real filing_ids and carry real prose.
  const events = Array.isArray(parsed?.events) ? parsed.events : null;
  const dayMap = Array.isArray(parsed?.day_map) ? parsed.day_map : [];
  const concalls = Array.isArray(parsed?.concalls) ? parsed.concalls : [];
  const mgmt = Array.isArray(parsed?.mgmt_flags) ? parsed.mgmt_flags : [];
  const calendar = Array.isArray(parsed?.calendar) ? parsed.calendar : [];
  const eventIssues = [];
  if (!events || events.length === 0) {
    issues.push('events_empty');
    eventIssues.push('No events array. Produce 6-10 events, each tied to a filing_id.');
  } else {
    const validIds = new Set(inputs.top_filings.map(f => Number(f.record_id)));
    let badId = 0, thin = 0;
    for (const ev of events) {
      if (!validIds.has(Number(ev?.filing_id))) badId++;
      if (typeof ev?.prose !== 'string' || ev.prose.trim().length < 90) thin++;
    }
    if (badId)  { issues.push(`event_filing_id_unknown:${badId}`); eventIssues.push(`${badId} event(s) used a filing_id not in top_filings.`); }
    if (thin)   { issues.push(`event_prose_thin:${thin}`);          eventIssues.push(`${thin} event(s) under 2-3 sentences.`); }
    const wantMin = Math.min(inputs.top_filings.length >= 18 ? 10 : 8, inputs.top_filings.length);
    if (events.length < wantMin) { issues.push(`events_too_few:${events.length}`); eventIssues.push(`Only ${events.length} events; cover more of the day (${inputs.top_filings.length} filings available).`); }
  }
  if (inputs.top_filings.length >= 6 && dayMap.length < 3) issues.push('day_map_too_thin');

  // Collect all prose into one blob for the banned/structural validators.
  const prose = [
    parsed?.headline, parsed?.dek, parsed?.the_take,
    ...dayMap,
    ...(events || []).map(e => e?.prose),
    ...mgmt.map(m => m?.prose),
    ...concalls.map(c => c?.prose),
    ...calendar,
  ].filter(Boolean).join(' ');

  const banned = [];
  for (const pat of PHRASE_PATTERNS) {
    const m = prose.match(pat);
    if (m) banned.push(m[0]);
  }
  if (banned.length) issues.push(`banned:${banned.slice(0, 5).join('|')}`);

  const structural = [];
  for (const rule of STRUCTURAL_RULES) {
    const hit = rule(prose, { full_read: prose });  // briefings have no the_full_read; pass whole prose
    if (hit && hit.name !== 'monotone_sentence_lengths') structural.push(hit);
  }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  return { ok: issues.length === 0, issues, banned, structural, eventIssues };
}
