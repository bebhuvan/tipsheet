// Backfill the "Questions answered" block on OLD articles — FAQs ONLY.
//
// Old notes were enriched when the prompt asked for ~2 FAQs. This regenerates
// 4–6 sharper FAQs for them via the same model the pipeline uses, and writes
// ONLY the faqs column. It never touches headline / dek / body / slug, so
// published URLs and analysis are untouched (a full re-enrich would rewrite the
// headline and therefore the URL — see queries.buildSlug).
//
// Safety / behaviour:
//   • Updates only `faqs` (UPDATE … SET faqs = ? WHERE record_id = ?).
//   • Resumable: by default only processes articles with < MIN_FAQS faqs, so a
//     re-run skips what's already done (and skips new-prompt articles).
//   • Validates against banned-patterns.mjs and a length/shape check; on failure
//     it RETRIES once, then leaves the article's existing faqs untouched rather
//     than writing slop.
//   • --dry-run prints what it would write without touching the DB.
//
// Usage (from pipeline/):
//   node --env-file=../.env.ci backfill_faqs.mjs [--limit N] [--dry-run] [--min 4] [--db ../data/filings.db]
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';
import { compatHeaders, tokenParam } from './llm-compat.mjs';
import { PHRASE_PATTERNS } from './banned-patterns.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
};
const LIMIT = Number(flag('limit', 0)) || 0;          // 0 = all
const DRY_RUN = !!flag('dry-run', false);
const MIN_FAQS = Number(flag('min', 4));               // backfill anything with fewer than this
const IDS = String(flag('ids', '')).split(',').map(s => s.trim()).filter(Boolean); // target exact record_ids
const CONCURRENCY = Math.max(1, Number(flag('concurrency', 4)));
const DB_PATH = String(flag('db', resolve(__dirname, '..', 'data', 'filings.db')));

const CFG = {
  apiKey: process.env.LLM_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENROUTER_API_KEY,
  model: process.env.LLM_MODEL || 'gemini-3.1-flash-lite',
  temperature: Number(process.env.FAQ_TEMPERATURE || 0.5),
  maxTokens: Number(process.env.FAQ_MAX_TOKENS || 1200),
};

const faqsSchema = {
  type: 'OBJECT',
  properties: {
    faqs: {
      type: 'ARRAY',
      minItems: 4,
      maxItems: 6,
      items: {
        type: 'OBJECT',
        properties: { question: { type: 'STRING' }, answer: { type: 'STRING' } },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['faqs'],
};

const parseJsonArray = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

function buildUserMessage(a) {
  const whatsNew = parseJsonArray(a.whats_new).map(b => `- ${b}`).join('\n');
  const watching = parseJsonArray(a.what_were_watching).map(b => `- ${b}`).join('\n');
  const num = a.the_number_value ? `THE NUMBER: ${a.the_number_value}${a.the_number_label ? ` — ${a.the_number_label}` : ''}` : '';
  return [
    `COMPANY: ${a.company || a.symbol} (${a.symbol})${a.sector ? ` — ${a.sector}` : ''}`,
    `HEADLINE: ${a.headline}`,
    a.dek ? `STANDFIRST: ${a.dek}` : '',
    num,
    whatsNew ? `WHAT'S NEW:\n${whatsNew}` : '',
    a.why_it_matters ? `WHY IT MATTERS: ${a.why_it_matters}` : '',
    watching ? `WHAT WE'RE WATCHING:\n${watching}` : '',
    a.the_full_read ? `THE FULL READ:\n${a.the_full_read}` : '',
  ].filter(Boolean).join('\n\n');
}

function bannedHit(text) {
  for (const re of PHRASE_PATTERNS) { if (re.test(text)) return re.source; }
  return null;
}

// Per-FAQ anti-slop validation with SALVAGE: a single bad answer shouldn't sink
// 5 brilliant ones. Keep the clean FAQs, drop the offenders, and pass as long as
// >= 4 clean ones remain (capped at 6). Returns { ok, issues, faqs: <clean subset> }.
function validateFaqs(faqs) {
  if (!Array.isArray(faqs)) return { ok: false, issues: ['not an array'], faqs: [] };
  const clean = [], issues = [], seen = new Set();
  for (const f of faqs) {
    const q = String(f?.question || '').trim();
    const a = String(f?.answer || '').trim();
    const bad = [];
    if (!q || !a) bad.push('empty');
    else {
      if (!q.endsWith('?')) bad.push('not a question');
      if (q.split(/\s+/).length < 4) bad.push('q too short');
      const words = a.split(/\s+/).length;
      if (words < 10) bad.push(`a too short (${words}w)`);
      if (words > 90) bad.push(`a too long (${words}w)`);
      const key = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) bad.push('duplicate'); else seen.add(key);
      const hit = bannedHit(`${q} ${a}`);
      if (hit) bad.push(`banned /${hit}/`);
    }
    if (bad.length === 0) clean.push({ question: q, answer: a });
    else issues.push(`"${q.slice(0, 28)}…": ${bad.join(', ')}`);
  }
  return { ok: clean.length >= 4, issues, faqs: clean.slice(0, 6) };
}

async function generateFaqs(ai, system, article) {
  const user = buildUserMessage(article);
  const baseUrl = process.env.LLM_BASE_URL || '';
  const useOpenAI = baseUrl && !/googleapis|generativelanguage/i.test(baseUrl);
  let lastIssues = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const sys = (attempt === 1 || !lastIssues) ? system
      : `${system}\n\nYOUR PREVIOUS ATTEMPT FAILED these exact checks: ${lastIssues.join(' | ')}.\nFix precisely those — rewrite the offending question/answer and strip every flagged word — while keeping all the others sharp. Still 4–6 items, each answer 2–3 declarative sentences that lead with the answer.`;
    let res;
    try {
      if (useOpenAI) {
        const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: compatHeaders(baseUrl, CFG.apiKey),
          body: JSON.stringify({
            model: CFG.model,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            response_format: { type: 'json_object' },
            temperature: CFG.temperature,
            ...tokenParam(baseUrl, CFG.maxTokens),
          }),
        });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const b = await r.json();
        const c = b.choices?.[0]?.message?.content || '{}';
        const s = c.indexOf('{'), e = c.lastIndexOf('}');
        res = { text: (s >= 0 && e > s ? c.slice(s, e + 1) : c), usageMetadata: b.usage || null };
      } else {
        res = await ai.models.generateContent({
          model: CFG.model,
          contents: [{ role: 'user', parts: [{ text: user }] }],
          config: {
            systemInstruction: sys,
            temperature: CFG.temperature,
            maxOutputTokens: CFG.maxTokens,
            responseMimeType: 'application/json',
            responseSchema: faqsSchema,
          },
        });
      }
    } catch (e) { return { ok: false, error: e.message }; }
    let parsed;
    try { parsed = JSON.parse(res.text || '{}'); } catch { lastIssues = ['invalid JSON']; continue; }
    const v = validateFaqs(parsed.faqs);
    if (v.ok) return { ok: true, faqs: v.faqs, usage: res.usageMetadata || null, attempts: attempt };
    lastIssues = v.issues;
  }
  return { ok: false, error: 'validation', issues: lastIssues };
}

async function main() {
  if (!CFG.apiKey) { console.error('Missing LLM_API_KEY / GOOGLE_API_KEY.'); process.exit(1); }
  const system = await readFile(resolve(__dirname, 'prompts', 'faqs_backfill_system.txt'), 'utf-8');
  const db = new Database(DB_PATH);
  const ai = new GoogleGenAI({ apiKey: CFG.apiKey });

  const rows = db.prepare(`
    SELECT e.record_id, e.headline, e.dek, e.the_number_value, e.the_number_label,
           e.whats_new, e.why_it_matters, e.what_were_watching, e.the_full_read,
           e.sector, e.faqs, r.symbol, r.company
      FROM filings_enriched e
      JOIN filings_raw r ON r.record_id = e.record_id
     WHERE e.validation_ok = 1
     ORDER BY e.enriched_at DESC
  `).all();

  let candidates;
  if (IDS.length) {
    const set = new Set(IDS.map(String));
    candidates = rows.filter(r => set.has(String(r.record_id)));   // retry exactly these, regardless of current faq count
  } else {
    candidates = rows.filter(r => parseJsonArray(r.faqs).length < MIN_FAQS);
  }
  const work = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  console.log(`[backfill-faqs] ${rows.length} enriched · ${candidates.length} ${IDS.length ? 'targeted by id' : `need >=${MIN_FAQS} faqs`} · processing ${work.length}${DRY_RUN ? ' (dry-run)' : ''} · model ${CFG.model}`);

  const update = db.prepare('UPDATE filings_enriched SET faqs = ? WHERE record_id = ?');
  let ok = 0, fail = 0, tokIn = 0, tokOut = 0, done = 0;

  // Generate CONCURRENCY at a time (LLM is the slow part); writes stay on the
  // main thread (better-sqlite3 is synchronous), so they can't race.
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(a => generateFaqs(ai, system, a).then(r => ({ a, r }))));
    for (const { a, r } of results) {
      done++;
      if (!r.ok) {
        fail++;
        console.log(`  ✗ ${a.symbol} #${a.record_id} — ${r.error}${r.issues ? ': ' + r.issues.slice(0, 2).join('; ') : ''}`);
        continue;
      }
      ok++;
      tokIn += r.usage?.promptTokenCount || 0;
      tokOut += r.usage?.candidatesTokenCount || 0;
      if (DRY_RUN) {
        console.log(`\n  ── ${a.symbol} #${a.record_id}: ${a.headline}`);
        for (const f of r.faqs) console.log(`     Q: ${f.question}\n     A: ${f.answer}`);
      } else {
        update.run(JSON.stringify(r.faqs), a.record_id);
      }
    }
    if (!DRY_RUN) console.log(`  …${done}/${work.length} (ok ${ok}, fail ${fail})`);
  }
  db.close();
  console.log(`\n[backfill-faqs] done · ok ${ok} · fail ${fail} · tokens in ${tokIn} out ${tokOut}`);
}

main().catch(e => { console.error(e); process.exit(1); });
