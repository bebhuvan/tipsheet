// Bakeoff: compare LLM models on identical filing inputs.
//
// Usage: node --env-file=../.env bakeoff.mjs [count]
//
// Picks `count` filings from the DB (1 high-score, 1 mid, 1 thin per set),
// calls each configured model with identical prompts, validates both outputs,
// and saves side-by-side results.
//
// Environment:
//   LLM_API_KEY          — Gemini API key
//   LLM_BASE_URL         — Gemini-compatible endpoint
//   LLM_MODEL            — Gemini model name (e.g. gemini-3.1-flash-lite)
//   DEEPSEEK_API_KEY     — DeepSeek API key
//   DEEPSEEK_BASE_URL    — DeepSeek endpoint (default: https://api.deepseek.com/v1)
//   DEEPSEEK_MODEL       — DeepSeek model name (default: deepseek-v4-flash)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASE_PATTERNS, STRUCTURAL_RULES } from './banned-patterns.mjs';
import { openDb } from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PATH = resolve(__dirname, 'prompts/system.txt');
const USER_PATH   = resolve(__dirname, 'prompts/user.txt');

// ─── Model configs ──────────────────────────────────────────────────

const MODELS = {
  gemini: {
    name:    process.env.LLM_MODEL || 'gemini-3.1-flash-lite',
    baseUrl: process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey:  process.env.LLM_API_KEY || process.env.GOOGLE_API_KEY,
  },
  deepseek: {
    name:    process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey:  process.env.DEEPSEEK_API_KEY,
  },
};

const TEMPERATURE = 0.7;   // Shared — not 1.0 (too noisy for comparison)
const MAX_TOKENS  = 1500;
const TIMEOUT_MS  = 45000;

// ─── Pick filings ───────────────────────────────────────────────────

function pickFilings(db, count = 3) {
  const high = db.prepare(`
    SELECT r.* FROM filings_raw r
    WHERE r.score >= 9
    ORDER BY RANDOM() LIMIT ?
  `).all(Math.ceil(count / 3));

  const mid = db.prepare(`
    SELECT r.* FROM filings_raw r
    WHERE r.score >= 7 AND r.score < 9
    ORDER BY RANDOM() LIMIT ?
  `).all(Math.ceil(count / 3));

  const thin = db.prepare(`
    SELECT r.* FROM filings_raw r
    WHERE r.score >= 5 AND r.score < 7
    ORDER BY RANDOM() LIMIT ?
  `).all(Math.max(1, count - high.length - mid.length));

  return [...high, ...mid, ...thin];
}

// ─── Call one model ─────────────────────────────────────────────────

async function callModel(modelConfig, systemPrompt, userMessage) {
  if (!modelConfig.apiKey) {
    return { ok: false, error: `missing API key for ${modelConfig.name}`, elapsed_ms: 0 };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const r = await fetch(`${modelConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${modelConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelConfig.name,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage },
        ],
        response_format: { type: 'json_object' },
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
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
    if (start === -1 || end <= start) {
      return { ok: false, error: 'no_json', elapsed_ms };
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

// ─── Validate ───────────────────────────────────────────────────────

function validate(parsed, raw) {
  const issues = [];
  if (typeof parsed?.headline !== 'string') issues.push('headline_missing');
  else if (parsed.headline.length > 85) issues.push(`headline_too_long:${parsed.headline.length}`);
  if (typeof parsed?.dek !== 'string') issues.push('dek_missing');
  if (!parsed?.the_number?.value) issues.push('the_number_missing');
  if (!Array.isArray(parsed?.whats_new) || parsed.whats_new.length === 0) issues.push('whats_new_empty');
  if (typeof parsed?.why_it_matters !== 'string' || parsed.why_it_matters.length < 30) issues.push('why_it_matters_thin');
  if (!Array.isArray(parsed?.what_were_watching) || parsed.what_were_watching.length === 0) issues.push('what_were_watching_empty');
  if (typeof parsed?.the_full_read !== 'string') issues.push('the_full_read_missing');
  else if (parsed.the_full_read.length < 200) issues.push(`the_full_read_thin:${parsed.the_full_read.length}`);

  const proseText = [
    parsed?.headline, parsed?.dek,
    ...(parsed?.whats_new || []),
    parsed?.why_it_matters,
    ...(parsed?.what_were_watching || []),
    parsed?.the_full_read,
  ].filter(Boolean).join(' ');

  const banned = [];
  for (const pat of PHRASE_PATTERNS) {
    const m = proseText.match(pat);
    if (m) banned.push(m[0]);
  }
  if (banned.length) issues.push(`banned:${banned.slice(0, 5).join('|')}`);

  const structural = [];
  for (const rule of STRUCTURAL_RULES) {
    const hit = rule(proseText, { full_read: parsed?.the_full_read });
    if (hit) structural.push(hit);
  }
  if (structural.length) issues.push(`structural:${structural.map(s => s.name).join('|')}`);

  const src = (raw.news_summary || '') + ' ' + (raw.rationale || '');
  const srcNums = new Set((src.match(/\d[\d,.]*/g) || []).map(m => m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, '')).filter(Boolean));
  const outNums = new Set((proseText.match(/\d[\d,.]*/g) || []).map(m => m.replace(/[,\s]/g, '').replace(/^\.+|\.+$/g, '')).filter(Boolean));
  const fabricated = [...outNums].filter(n => n.length >= 3 && !srcNums.has(n));

  return { ok: issues.length === 0, issues, banned, structural, fabricated };
}

// ─── Build user message ─────────────────────────────────────────────

function buildUserMessage(template, raw) {
  return template
    .replace('{company}',        raw.company || '?')
    .replace('{symbol}',         raw.symbol || '?')
    .replace('{event_category}', raw.event_category_raw || '?')
    .replace('{event_type}',     raw.event_type || '?')
    .replace('{sentiment}',      raw.sentiment || '(blank)')
    .replace('{score}',          String(raw.score ?? '?'))
    .replace('{news_summary}',   (raw.news_summary || '').slice(0, 4000) || '(no news summary)')
    .replace('{rationale}',      (raw.rationale || '').slice(0, 4000) || '(no rationale)');
}

// ─── Cost estimation ────────────────────────────────────────────────

function estimateCost(modelName, usage) {
  if (!usage) return null;
  const pricing = {
    'gemini-3.1-flash-lite':   { input: 0.15, output: 0.60 },
    'gemini-2.5-flash':        { input: 0.15, output: 0.60 },
    'deepseek-v4-flash':       { input: 0.12, output: 0.24 },
    'deepseek-v4-pro':         { input: 1.10, output: 2.20 },
  };
  const p = pricing[modelName] || { input: 0.10, output: 0.50 };
  const inTokens  = usage.prompt_tokens || 0;
  const outTokens = usage.completion_tokens || 0;
  return {
    input_tokens: inTokens,
    output_tokens: outTokens,
    cost_usd: (inTokens * p.input + outTokens * p.output) / 1_000_000,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const count = Number(process.argv[2]) || 3;

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          TIPSHEET LLM BAKEOFF                      ║');
  console.log('║  Gemini Flash Lite vs DeepSeek V4-Flash             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  const activeModels = Object.entries(MODELS).filter(([, cfg]) => cfg.apiKey);
  if (activeModels.length < 2) {
    console.log('⚠  Need at least 2 API keys to run a bakeoff.');
    console.log('   Set: LLM_API_KEY (Gemini) and DEEPSEEK_API_KEY (DeepSeek)');
    for (const [name, cfg] of Object.entries(MODELS)) {
      console.log(`   ${name}: ${cfg.apiKey ? '✓ key set' : '✗ missing'}`);
    }
    if (activeModels.length === 0) process.exit(1);
    console.log(`   Running with ${activeModels.length} model(s) only.\n`);
  }

  const systemPrompt = await readFile(SYSTEM_PATH, 'utf8');
  const userTemplate = await readFile(USER_PATH, 'utf8');

  const db = openDb();
  const filings = pickFilings(db, count);
  console.log(`Selected ${filings.length} filings for bakeoff:`);
  for (const f of filings) {
    console.log(`  score=${f.score} ${(f.symbol || '?').padEnd(14)} ${(f.event_category_raw || f.event_type || '').slice(0, 30)}`);
  }
  console.log();

  const results = [];

  for (const filing of filings) {
    const userMsg = buildUserMessage(userTemplate, filing);
    console.log(`── Filing: ${filing.symbol} (score ${filing.score}, record_id ${filing.record_id}) ──`);

    const trialResult = {
      record_id: filing.record_id,
      symbol: filing.symbol,
      score: filing.score,
      category: filing.event_category_raw || filing.event_type,
      models: {},
    };

    for (const [modelKey, modelCfg] of activeModels) {
      process.stdout.write(`  ${modelKey.padEnd(12)} ${modelCfg.name.padEnd(28)} `);
      const result = await callModel(modelCfg, systemPrompt, userMsg);

      if (!result.ok) {
        console.log(`✗ ${result.error}`);
        trialResult.models[modelKey] = { model: modelCfg.name, ok: false, error: result.error, elapsed_ms: result.elapsed_ms };
        continue;
      }

      const v = validate(result.parsed, filing);
      const cost = estimateCost(modelCfg.name, result.usage);

      console.log([
        v.ok ? '✓' : '✗',
        `${result.elapsed_ms}ms`,
        cost ? `$${cost.cost_usd.toFixed(5)}` : '',
        `banned=${v.banned.length}`,
        `structural=${v.structural.length}`,
        `fabricated=${v.fabricated.length}`,
        v.ok ? '' : `issues=${v.issues.length}`,
      ].filter(Boolean).join('  '));

      trialResult.models[modelKey] = {
        model: modelCfg.name,
        ok: v.ok,
        elapsed_ms: result.elapsed_ms,
        cost,
        validation: {
          pass: v.ok,
          issues_count: v.issues.length,
          banned_count: v.banned.length,
          banned_phrases: v.banned,
          structural_count: v.structural.length,
          structural_names: v.structural.map(s => s.name),
          fabricated_count: v.fabricated.length,
        },
        headline: result.parsed?.headline,
        the_full_read_length: result.parsed?.the_full_read?.length || 0,
        the_full_read_words: (result.parsed?.the_full_read || '').split(/\s+/).length,
      };
    }
    results.push(trialResult);
    console.log();
  }

  // ─── Summary ────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════');

  for (const [modelKey] of activeModels) {
    const trials = results.map(r => r.models[modelKey]).filter(Boolean);
    const passed = trials.filter(t => t.ok).length;
    const avgMs  = trials.length ? Math.round(trials.reduce((s, t) => s + (t.elapsed_ms || 0), 0) / trials.length) : 0;
    const totalCost = trials.reduce((s, t) => s + (t.cost?.cost_usd || 0), 0);
    const totalBanned = trials.reduce((s, t) => s + (t.validation?.banned_count || 0), 0);
    const totalStruct = trials.reduce((s, t) => s + (t.validation?.structural_count || 0), 0);
    const totalFab    = trials.reduce((s, t) => s + (t.validation?.fabricated_count || 0), 0);

    console.log(`\n  ${modelKey} (${MODELS[modelKey].name}):`);
    console.log(`    Pass rate:        ${passed}/${trials.length}`);
    console.log(`    Avg latency:      ${avgMs}ms`);
    console.log(`    Total cost:       $${totalCost.toFixed(5)}`);
    console.log(`    Total banned:     ${totalBanned}`);
    console.log(`    Total structural: ${totalStruct}`);
    console.log(`    Total fabricated: ${totalFab}`);
  }

  // ─── Save results ─────────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir = resolve(__dirname, '..', 'data');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, `bakeoff-results-${dateStr}.json`);
  await writeFile(outPath, JSON.stringify({ date: dateStr, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, results }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
