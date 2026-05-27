// Orchestrator. Three commands:
//   node run.mjs poll              — fetch feed, insert new filings
//   node run.mjs enrich [N]        — enrich up to N un-enriched filings (default 50)
//   node run.mjs both [N]          — poll then enrich in one pass
//   node run.mjs stats             — show DB stats
//
// Run with: node --env-file=../.env run.mjs <command>

import { fetchLatestFeed, flattenItem } from './poller.mjs';
import { openDb, insertRaw, hasRecord, insertEnriched, listUnenriched, stats, upsertFundamentals, fundamentalCount, insertConcalls, concallStats, listUnenrichedConcalls, insertEnrichedConcall, insertMacroEvents, macroCalendarStats, upsertBriefing, listCompaniesNeedingTijoriSlug, setTijoriSlug, listRadarSourceRows, listRecentConcallFlags, upsertRadarItems, deactivateStaleRadarItems, listExistingRadarItems, updateSourceHealth } from './db.mjs';
import { enrich, PROMPT_VERSION } from './enricher.mjs';
import { enrichConcall, CONCALL_PROMPT_VERSION } from './concalls_enricher.mjs';
import { fetchFundamentals, flattenFundamental, resolveTijoriCompanySlug } from './fundamentals.mjs';
import { paginateConcalls } from './concalls_poller.mjs';
import { paginateCalendar, flattenCalendarEvent } from './idh_poller.mjs';
import { gatherBriefingInputs, enrichBriefing, BRIEFING_PROMPT_VERSION } from './briefings_enricher.mjs';
import { buildRadarItems, radarItemHash } from './radar.mjs';
import { enrichRadarItem } from './radar_enricher.mjs';
import { pathToFileURL } from 'node:url';

const SCORE_MIN = Number(process.env.SCORE_MIN || 5);
const PARALLEL  = Number(process.env.PARALLEL  || 4);

export async function poll() {
  const startedAt = Date.now();
  console.log('[poll] fetching tijori feed...');
  const items = await fetchLatestFeed();
  console.log(`[poll] received ${items.length} items`);

  const db = openDb();
  // Always store all valid items in filings_raw — the score filter is applied at
  // enrich-time, not poll-time. This preserves history if we ever want to lower the
  // SCORE_MIN threshold and re-process older filings.
  let inserted = 0, skipped_invalid = 0, skipped_dup = 0;
  for (const item of items) {
    const flat = flattenItem(item);
    if (!flat) { skipped_invalid++; continue; }
    if (hasRecord(db, flat.record_id)) { skipped_dup++; continue; }
    insertRaw(db, flat);
    inserted++;
  }
  console.log(`[poll] inserted=${inserted}  skipped(invalid)=${skipped_invalid}  skipped(dup)=${skipped_dup}`);
  updateSourceHealth(db, 'filings', {
    status: 'success',
    startedAt,
    inserted,
    items: items.length,
    latestSourceTime: items.map(item => flattenItem(item)?.created_on).filter(Boolean).sort().at(-1) || null,
    meta: { skipped_invalid, skipped_dup },
  });
  return { inserted, skipped_invalid, skipped_dup };
}

export async function enrichBatch(max = 50) {
  const startedAt = Date.now();
  const db = openDb();
  const pending = listUnenriched(db, SCORE_MIN, max);
  console.log(`[enrich] ${pending.length} filings pending (score >= ${SCORE_MIN})`);
  if (pending.length === 0) {
    updateSourceHealth(db, 'filings_enrichment', { status: 'success', startedAt, enriched: 0, items: 0 });
    return { ok: 0, fail: 0 };
  }

  let ok = 0, fail = 0, totalIn = 0, totalOut = 0;

  for (let i = 0; i < pending.length; i += PARALLEL) {
    const batch = pending.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async (raw) => {
      let result = await enrich(raw);
      let retries = 0;
      
      while (!result.ok && retries < 3) {
        retries++;
        await sleep(600);
        if (result.parsed && result.validation?.issues?.length) {
          result = await enrich(raw, result);   // pass previous as feedback
        } else if (!['json_parse', 'no_json'].includes(result.error)) {
          result = await enrich(raw);
        } else {
          result = await enrich(raw);            // plain retry for parse errors
        }
      }

      // FALLBACK: If we exhausted retries and the only issues are stylistic, force accept it.
      if (!result.ok && result.parsed && result.validation?.issues) {
        const onlyStyleIssues = result.validation.issues.every(i => i.startsWith('banned:') || i.startsWith('structural:'));
        if (onlyStyleIssues) {
          result.ok = true;
          result.forced_pass = true;
        }
      }
      const u = result.usage || {};
      totalIn  += u.prompt_tokens || 0;
      totalOut += u.completion_tokens || 0;

      if (result.ok) {
        ok++;
        const p = result.parsed;
        insertEnriched(db, {
          record_id:           raw.record_id,
          headline:            p.headline,
          dek:                 p.dek,
          the_number_value:    p.the_number?.value || null,
          the_number_label:    p.the_number?.label || null,
          whats_new:           JSON.stringify(p.whats_new || []),
          why_it_matters:      p.why_it_matters || null,
          what_were_watching:  JSON.stringify(p.what_were_watching || []),
          faqs:                JSON.stringify(p.faqs || []),
          the_full_read:       p.the_full_read || null,
          editorial_tone:      p.editorial_tone?.label || null,
          tone_score:          Number.isFinite(Number(p.editorial_tone?.score)) ? Math.round(Number(p.editorial_tone.score)) : null,
          tone_confidence:     p.editorial_tone?.confidence || null,
          tone_reason:         p.editorial_tone?.reason || null,
          canonical_category:  p.canonical_category || null,
          sector:              p.sector || null,
          key_entities:        JSON.stringify(p.key_entities || []),
          model_used:          result.model,
          prompt_version:      result.promptVersion,
          validation_ok:       1,
          validation_issues:   result.forced_pass ? JSON.stringify(result.validation.issues) : null,
        });
        console.log(`  ✓ ${(raw.symbol || '?').padEnd(12)} ${result.elapsed_ms}ms  ${p.headline?.slice(0, 70) || ''}${result.forced_pass ? ' (FORCED PASS)' : ''}`);
      } else {
        fail++;
        insertEnriched(db, {
          record_id:           raw.record_id,
          headline:            null, dek: null,
          the_number_value:    null, the_number_label: null,
          whats_new:           null, why_it_matters: null, what_were_watching: null, faqs: null, the_full_read: null,
          editorial_tone:      null, tone_score: null, tone_confidence: null, tone_reason: null,
          canonical_category:  null, sector: null, key_entities: null,
          model_used:          '',
          prompt_version:      PROMPT_VERSION,
          validation_ok:       0,
          validation_issues:   JSON.stringify([result.error || 'unknown', ...(result.validation?.issues || [])]),
        });
        console.log(`  ✗ ${(raw.symbol || '?').padEnd(12)} ${result.elapsed_ms ?? '?'}ms  ${result.error}${result.validation?.issues ? ' | ' + result.validation.issues.slice(0, 3).join(';') : ''}`);
      }
    }));
  }
  console.log(`[enrich] ok=${ok}  fail=${fail}  tokens in=${totalIn} out=${totalOut}`);
  updateSourceHealth(db, 'filings_enrichment', {
    status: fail ? 'partial' : 'success',
    startedAt,
    enriched: ok,
    items: pending.length,
    meta: { fail, totalIn, totalOut },
  });
  return { ok, fail, totalIn, totalOut };
}

export async function enrichIds(ids = []) {
  const normalized = ids
    .flatMap(id => String(id || '').split(','))
    .map(id => Number(id.trim()))
    .filter(Number.isInteger);
  const unique = [...new Set(normalized)];
  if (!unique.length) {
    console.log('[enrich-ids] no valid record ids supplied');
    return { ok: 0, fail: 0 };
  }

  const db = openDb();
  const placeholders = unique.map(() => '?').join(',');
  const pending = db.prepare(`
    SELECT r.*
    FROM filings_raw r
    WHERE r.record_id IN (${placeholders})
    ORDER BY r.created_on DESC
  `).all(...unique);
  const found = new Set(pending.map(row => Number(row.record_id)));
  const missing = unique.filter(id => !found.has(id));
  if (missing.length) console.log(`[enrich-ids] missing raw rows: ${missing.join(',')}`);
  console.log(`[enrich-ids] ${pending.length} filings selected`);

  let ok = 0, fail = 0, totalIn = 0, totalOut = 0;
  for (const raw of pending) {
    let result = await enrich(raw);
    let retries = 0;

    while (!result.ok && retries < 3) {
      retries++;
      await sleep(600);
      if (result.parsed && result.validation?.issues?.length) {
        result = await enrich(raw, result);
      } else {
        result = await enrich(raw);
      }
    }

    if (!result.ok && result.parsed && result.validation?.issues) {
      const onlyStyleIssues = result.validation.issues.every(i => i.startsWith('banned:') || i.startsWith('structural:'));
      if (onlyStyleIssues) {
        result.ok = true;
        result.forced_pass = true;
      }
    }

    const u = result.usage || {};
    totalIn += u.prompt_tokens || 0;
    totalOut += u.completion_tokens || 0;

    if (result.ok) {
      ok++;
      const p = result.parsed;
      insertEnriched(db, {
        record_id:           raw.record_id,
        headline:            p.headline,
        dek:                 p.dek,
        the_number_value:    p.the_number?.value || null,
        the_number_label:    p.the_number?.label || null,
        whats_new:           JSON.stringify(p.whats_new || []),
        why_it_matters:      p.why_it_matters || null,
        what_were_watching:  JSON.stringify(p.what_were_watching || []),
        faqs:                JSON.stringify(p.faqs || []),
        the_full_read:       p.the_full_read || null,
        editorial_tone:      p.editorial_tone?.label || null,
        tone_score:          Number.isFinite(Number(p.editorial_tone?.score)) ? Math.round(Number(p.editorial_tone.score)) : null,
        tone_confidence:     p.editorial_tone?.confidence || null,
        tone_reason:         p.editorial_tone?.reason || null,
        canonical_category:  p.canonical_category || null,
        sector:              p.sector || null,
        key_entities:        JSON.stringify(p.key_entities || []),
        model_used:          result.model,
        prompt_version:      result.promptVersion,
        validation_ok:       1,
        validation_issues:   result.forced_pass ? JSON.stringify(result.validation.issues) : null,
      });
      console.log(`  ✓ ${String(raw.record_id).padEnd(8)} ${(raw.symbol || '?').padEnd(12)} ${result.elapsed_ms}ms  ${p.headline?.slice(0, 70) || ''}${result.forced_pass ? ' (FORCED PASS)' : ''}`);
    } else {
      fail++;
      insertEnriched(db, {
        record_id:           raw.record_id,
        headline:            null, dek: null,
        the_number_value:    null, the_number_label: null,
        whats_new:           null, why_it_matters: null, what_were_watching: null, faqs: null, the_full_read: null,
        editorial_tone:      null, tone_score: null, tone_confidence: null, tone_reason: null,
        canonical_category:  null, sector: null, key_entities: null,
        model_used:          '',
        prompt_version:      PROMPT_VERSION,
        validation_ok:       0,
        validation_issues:   JSON.stringify([result.error || 'unknown', ...(result.validation?.issues || [])]),
      });
      console.log(`  ✗ ${String(raw.record_id).padEnd(8)} ${(raw.symbol || '?').padEnd(12)} ${result.elapsed_ms ?? '?'}ms  ${result.error}${result.validation?.issues ? ' | ' + result.validation.issues.slice(0, 3).join(';') : ''}`);
    }
  }
  console.log(`[enrich-ids] ok=${ok} fail=${fail} tokens in=${totalIn} out=${totalOut}`);
  return { ok, fail, totalIn, totalOut };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchFundamentalsAll() {
  const startedAt = Date.now();
  console.log('[fundamentals] fetching from Kite Screener...');
  const t0 = Date.now();
  const raw = await fetchFundamentals();
  console.log(`[fundamentals] got ${raw.length} rows in ${Date.now()-t0}ms`);
  const rows = raw.map(flattenFundamental).filter(r => r.symbol);
  const db = openDb();
  const n = upsertFundamentals(db, rows);
  console.log(`[fundamentals] upserted ${n} rows; total in DB: ${fundamentalCount(db)}`);
  updateSourceHealth(db, 'fundamentals', { status: 'success', startedAt, inserted: n, items: rows.length });
  return { count: n };
}

export async function resolveTijoriSlugs(max = 100) {
  const db = openDb();
  const rows = listCompaniesNeedingTijoriSlug(db, max);
  console.log(`[tijori-slugs] ${rows.length} companies need Tijori slugs (max ${max})`);
  let ok = 0, fail = 0;
  for (const row of rows) {
    const slug = await resolveTijoriCompanySlug(row);
    if (slug) {
      setTijoriSlug(db, row.symbol, slug);
      ok++;
      console.log(`  ✓ ${row.symbol.padEnd(12)} ${slug}`);
    } else {
      fail++;
      console.log(`  ✗ ${row.symbol.padEnd(12)} ${row.company}`);
    }
    await sleep(120);
  }
  console.log(`[tijori-slugs] ok=${ok} fail=${fail}`);
  return { ok, fail };
}

export async function generateRadar({ days = 30, limit = 80, enrich = process.env.RADAR_ENRICH !== '0' } = {}) {
  const startedAt = Date.now();
  const db = openDb();
  const sourceRows = listRadarSourceRows(db, days);
  const concallFlags = listRecentConcallFlags(db, Math.max(days, 45));
  const items = buildRadarItems(sourceRows, concallFlags, { limit });

  // Resolve evidence rows for each item (by record_id). We already have them in sourceRows.
  const rowsByRecord = new Map();
  for (const r of sourceRows) rowsByRecord.set(r.record_id, r);

  // Compute hashes and consult the existing radar_items table so we don't re-call
  // the LLM for items whose evidence + flags haven't changed since the last run.
  const existing = listExistingRadarItems(db);
  for (const item of items) {
    item.why_now_hash = radarItemHash(item);
    item.why_now_source = 'template'; // overwritten below if LLM succeeds or cache hits
  }

  let llmCalls = 0, llmCached = 0, llmFailed = 0, llmEscaped = 0;
  if (enrich) {
    for (const item of items) {
      const key = `${item.symbol}::${item.trigger_type}`;
      const prev = existing.get(key);
      if (prev && prev.why_now_hash === item.why_now_hash && prev.why_now_source === 'llm' && prev.why_now) {
        item.why_now = prev.why_now;
        item.why_now_source = 'llm';
        llmCached++;
        continue;
      }
      const evidence = (item.evidence_record_ids || []).map(id => rowsByRecord.get(id)).filter(Boolean);
      const result = await enrichRadarItem(item, evidence);
      if (result.ok && !result.escape) {
        item.why_now = result.why_now;
        item.why_now_source = 'llm';
        llmCalls++;
        console.log(`  [llm] ${item.symbol.padEnd(12)} ${item.trigger_type.padEnd(16)} ${result.elapsed_ms}ms`);
      } else if (result.ok && result.escape) {
        // Model said the evidence is too thin — keep the templated whyNow but log it.
        item.why_now_source = 'template';
        llmEscaped++;
        console.log(`  [llm] ${item.symbol.padEnd(12)} ${item.trigger_type.padEnd(16)} INSUFFICIENT_EVIDENCE (kept template)`);
      } else {
        item.why_now_source = 'failed';
        llmFailed++;
        console.log(`  [llm-fail] ${item.symbol.padEnd(12)} ${item.trigger_type.padEnd(16)} ${result.error || 'unknown'}`);
      }
    }
  }

  const n = upsertRadarItems(db, items);
  const activeKeys = items.map(item => `${item.symbol}::${item.trigger_type}`);
  const stale = deactivateStaleRadarItems(db, activeKeys);
  console.log(`[radar] source_filings=${sourceRows.length} concall_flags=${concallFlags.length} active=${n} stale=${stale}`);
  if (enrich) {
    console.log(`[radar] llm: ${llmCalls} new · ${llmCached} cached · ${llmEscaped} thin · ${llmFailed} failed`);
  }
  for (const item of items.slice(0, 10)) {
    console.log(`  ${String(Math.round(item.radar_score)).padStart(3)} ${item.symbol.padEnd(12)} ${item.trigger_type.padEnd(16)} ${item.title}`);
  }
  updateSourceHealth(db, 'radar', {
    status: 'success',
    startedAt,
    inserted: n,
    items: items.length,
    meta: { sourceRows: sourceRows.length, stale, llmCalls, llmCached, llmFailed, llmEscaped },
  });
  return { active: n, stale, llmCalls, llmCached, llmFailed, llmEscaped };
}

function showStats() {
  const db = openDb();
  const s = stats(db);
  console.log('── stats ──');
  console.log(`  raw filings:      ${s.raw}`);
  console.log(`  enriched (ok):    ${s.enriched_ok}`);
  console.log(`  enriched (fail):  ${s.enriched_fail}`);
  console.log(`  score distribution:`);
  for (const { score, c } of s.score_dist) console.log(`    ${score}: ${c}`);
  console.log(`  by category:`);
  for (const { cat, c } of s.by_category) console.log(`    ${(cat || 'null').padEnd(14)} ${c}`);
  const cs = concallStats(db);
  console.log('── concalls ──');
  console.log(`  raw concalls:          ${cs.total}`);
  console.log(`  symbol-mapped:         ${cs.mapped}`);
  console.log(`  unmapped (no fundament): ${cs.unmapped}`);
  console.log(`  with mgmt-consistency: ${cs.with_mgmt_flag}`);
  console.log(`  enriched (ok):         ${cs.enriched}`);
  console.log(`  latest event:          ${cs.latest_event || '(none)'}`);
}

export async function enrichConcallsBatch(max = 50) {
  const startedAt = Date.now();
  const db = openDb();
  const pending = listUnenrichedConcalls(db, max);
  console.log(`[concalls-enrich] ${pending.length} concalls pending`);
  if (pending.length === 0) {
    updateSourceHealth(db, 'concalls_enrichment', { status: 'success', startedAt, enriched: 0, items: 0 });
    return { ok: 0, fail: 0 };
  }

  let ok = 0, fail = 0, totalIn = 0, totalOut = 0, totalCached = 0;

  for (let i = 0; i < pending.length; i += PARALLEL) {
    const batch = pending.slice(i, i + PARALLEL);
    await Promise.all(batch.map(async (raw) => {
      let result = await enrichConcall(raw);
      if (!result.ok) {
        await sleep(600);
        if (result.parsed && result.validation?.issues?.length) {
          result = await enrichConcall(raw, result);
        } else {
          result = await enrichConcall(raw);
        }
      }
      const u = result.usage || {};
      totalIn  += u.prompt_tokens || 0;
      totalOut += u.completion_tokens || 0;
      totalCached += u.prompt_tokens_details?.cached_tokens || 0;

      if (!result.ok && result.parsed && result.validation?.issues) {
        const onlyStyleIssues = result.validation.issues.every(i => i.startsWith('banned:') || i.startsWith('structural:'));
        if (onlyStyleIssues) {
          result.ok = true;
          result.forced_pass = true;
        }
      }

      if (result.ok) {
        ok++;
        const p = result.parsed;
        insertEnrichedConcall(db, {
          isin:               raw.isin,
          event_time:         raw.event_time,
          headline:           p.headline,
          dek:                p.dek,
          the_take:           p.the_take,
          inconsistency_flag: p.inconsistency_flag,
          whats_new:          JSON.stringify(p.whats_new || []),
          themes:             JSON.stringify(p.themes || []),
          guidance_watch:      JSON.stringify(p.guidance_watch || []),
          risk_flags:          JSON.stringify(p.risk_flags || []),
          key_quotes:         JSON.stringify(p.key_quotes || []),
          the_brief:          p.the_brief,
          canonical_category: p.canonical_category || 'Concalls',
          model_used:         result.model,
          prompt_version:     result.promptVersion,
          validation_ok:      1,
          validation_issues:  result.forced_pass ? JSON.stringify(result.validation.issues) : null,
        });
        console.log(`  ✓ ${(raw.symbol || raw.slug || '?').padEnd(20)} ${result.elapsed_ms}ms  ${p.headline?.slice(0, 70) || ''}${result.forced_pass ? ' (FORCED PASS)' : ''}`);
      } else {
        fail++;
        insertEnrichedConcall(db, {
          isin: raw.isin, event_time: raw.event_time,
          headline: null, dek: null, the_take: null, inconsistency_flag: null,
          whats_new: null, themes: null, guidance_watch: null, risk_flags: null, key_quotes: null, the_brief: null,
          canonical_category: 'Concalls',
          model_used: '', prompt_version: CONCALL_PROMPT_VERSION,
          validation_ok: 0,
          validation_issues: JSON.stringify([result.error || 'unknown', ...(result.validation?.issues || [])]),
        });
        console.log(`  ✗ ${(raw.symbol || raw.slug || '?').padEnd(20)} ${result.elapsed_ms ?? '?'}ms  ${result.error}${result.validation?.issues ? ' | ' + result.validation.issues.slice(0, 3).join(';') : ''}`);
      }
    }));
  }
  console.log(`[concalls-enrich] ok=${ok}  fail=${fail}  tokens in=${totalIn} (cached ${totalCached}) out=${totalOut}`);
  updateSourceHealth(db, 'concalls_enrichment', {
    status: fail ? 'partial' : 'success',
    startedAt,
    enriched: ok,
    items: pending.length,
    meta: { fail, totalIn, totalOut, totalCached },
  });
  return { ok, fail };
}

/**
 * Pull the IDH macro calendar for a date window (defaults to today through next 14 days).
 * Stores events in macro_calendar (idempotent PK upsert: same event reappears with Actual
 * filled in after release; we replace).
 */
export async function pollMacroCalendar({ from_date = null, to_date = null, max_pages = 5 } = {}) {
  const startedAt = Date.now();
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  from_date = from_date || fmt(today);
  if (!to_date) {
    const end = new Date(today); end.setDate(end.getDate() + 14);
    to_date = fmt(end);
  }
  console.log(`[macro-cal] pulling ${from_date} → ${to_date} (max ${max_pages} pages)...`);
  const db = openDb();
  let totalSeen = 0, totalInserted = 0, totalInvalid = 0, pageN = 0;
  for await (const page of paginateCalendar({ from_date, to_date })) {
    pageN++;
    if (pageN > max_pages) break;
    const rows = [];
    for (const item of page.events) {
      const flat = flattenCalendarEvent(item);
      if (!flat) { totalInvalid++; continue; }
      rows.push(flat);
    }
    if (rows.length) {
      insertMacroEvents(db, rows);
      totalSeen     += page.events.length;
      totalInserted += rows.length;
    }
    console.log(`  page ${pageN}: events=${page.events.length} valid=${rows.length} invalid=${totalInvalid} meta=${JSON.stringify(page.meta)}`);
    if (rows.length === 0) break;
  }
  console.log(`[macro-cal] done: pages=${pageN} seen=${totalSeen} inserted=${totalInserted} invalid=${totalInvalid}`);
  updateSourceHealth(db, 'macro_calendar', {
    status: 'success',
    startedAt,
    inserted: totalInserted,
    items: totalSeen,
    latestSourceTime: to_date,
    meta: { from_date, to_date, invalid: totalInvalid, pages: pageN },
  });
  return { seen: totalSeen, inserted: totalInserted };
}

/**
 * Generate The Open or The Close briefing for a given date (defaults to today IST).
 * Idempotent: re-running upserts in place.
 */
export async function generateBriefing(type, dateYmd = null) {
  const startedAt = Date.now();
  if (!['open', 'close'].includes(type)) throw new Error("type must be 'open' or 'close'");
  if (!dateYmd) {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
    dateYmd = ist.toISOString().slice(0, 10);
  }
  const db = openDb();
  console.log(`[briefing] gathering inputs for ${type} ${dateYmd}...`);
  const inputs = gatherBriefingInputs(db, type, dateYmd);
  console.log(`[briefing] inputs: filings=${inputs.top_filings.length} mgmt_flags=${inputs.mgmt_consistency_flags.length} macro=${inputs.macro_events_today.length} market=${inputs.market_snapshot.length}`);
  if (inputs.top_filings.length === 0 && inputs.macro_events_today.length === 0) {
    console.log('[briefing] nothing to brief — skipping');
    updateSourceHealth(db, `briefing_${type}`, { status: 'success', startedAt, items: 0, latestSourceTime: dateYmd, meta: { skipped: true } });
    return { skipped: true };
  }
  const t0 = Date.now();
  let result = await enrichBriefing(inputs);
  console.log(`[briefing] LLM call: ${result.elapsed_ms || (Date.now()-t0)}ms ok=${result.ok}${result.usage ? ` tokens in/out: ${result.usage.prompt_tokens}/${result.usage.completion_tokens}` : ''}`);
  // Feedback retry on validation failure
  if (!result.ok && result.parsed && result.validation?.issues?.length) {
    console.log(`[briefing] retrying with feedback: ${result.validation.issues.slice(0,3).join('; ')}`);
    const t1 = Date.now();
    const retry = await enrichBriefing(inputs, result);
    console.log(`[briefing] retry: ${retry.elapsed_ms || (Date.now()-t1)}ms ok=${retry.ok}${retry.usage ? ` tokens in/out: ${retry.usage.prompt_tokens}/${retry.usage.completion_tokens}` : ''}`);
    if (retry.parsed) result = retry;
  }
  if (!result.ok) {
    console.log(`[briefing] ✗ ${result.error}${result.validation?.issues ? ' | ' + result.validation.issues.slice(0,5).join(';') : ''}`);
    if (result.raw_error) console.log('  raw:', result.raw_error);
  }
  if (!result.parsed) return result;

  const p = result.parsed;
  upsertBriefing(db, {
    type, date: dateYmd,
    headline:        p.headline,
    dek:             p.dek,
    the_take:        p.the_take,
    sections:        JSON.stringify({ events: p.events || [], day_map: p.day_map || [], concalls: p.concalls || [], mgmt_flags: p.mgmt_flags || [], calendar: p.calendar || [] }),
    input_summary:   JSON.stringify({
      filings_count: inputs.top_filings.length,
      mgmt_flags_count: inputs.mgmt_consistency_flags.length,
      macro_count: inputs.macro_events_today.length,
      market_count: inputs.market_snapshot.length,
    }),
    model_used:      result.model,
    prompt_version:  result.promptVersion,
    validation_ok:   result.ok ? 1 : 0,
    validation_issues: result.ok ? null : JSON.stringify(result.validation?.issues || []),
  });
  console.log(`[briefing] ✓ stored: ${p.headline}`);
  updateSourceHealth(db, `briefing_${type}`, {
    status: result.ok ? 'success' : 'partial',
    startedAt,
    inserted: 1,
    items: inputs.top_filings.length,
    latestSourceTime: dateYmd,
    meta: { macro_count: inputs.macro_events_today.length, mgmt_flags_count: inputs.mgmt_consistency_flags.length },
  });
  return result;
}

export async function pollConcalls(maxItems = 100, opts = {}) {
  const startedAt = Date.now();
  console.log(`[concalls] polling Tijori Concall Monitor (budget=${maxItems})...`);
  const db = openDb();
  let totalSeen = 0, totalInserted = 0, totalMapped = 0, totalUnmapped = 0, totalInvalid = 0, pageN = 0;
  for await (const page of paginateConcalls({ maxItems, ...opts })) {
    pageN++;
    totalInvalid += page.invalid_count;
    if (page.items.length === 0) break;
    const r = insertConcalls(db, page.items);
    totalSeen     += page.items.length;
    totalInserted += r.inserted;
    totalMapped   += r.mapped;
    totalUnmapped += r.unmapped;
    console.log(`  page ${pageN}: seen=${page.items.length} new=${r.inserted} mapped=${r.mapped} unmapped=${r.unmapped} invalid=${page.invalid_count}`);
  }
  console.log(`[concalls] done: pages=${pageN} seen=${totalSeen} new=${totalInserted} mapped=${totalMapped} unmapped=${totalUnmapped} invalid=${totalInvalid}`);
  updateSourceHealth(db, 'concalls', {
    status: 'success',
    startedAt,
    inserted: totalInserted,
    items: totalSeen,
    meta: { mapped: totalMapped, unmapped: totalUnmapped, invalid: totalInvalid, pages: pageN },
  });
  return { seen: totalSeen, inserted: totalInserted };
}

// ─── entrypoint ─────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2] || 'both';
  const n   = Number(process.argv[3]) || 50;

  try {
    if (cmd === 'poll')              { await poll(); }
    else if (cmd === 'enrich')       { await enrichBatch(n); }
    else if (cmd === 'enrich-ids')   { await enrichIds(process.argv.slice(3)); }
    else if (cmd === 'both')         { await poll(); await enrichBatch(n); await resolveTijoriSlugs(50); await generateRadar(); }
    else if (cmd === 'fetch-fundamentals')    { await fetchFundamentalsAll(); }
    else if (cmd === 'resolve-tijori-slugs')   { await resolveTijoriSlugs(n || 100); }
    else if (cmd === 'generate-radar')         { await generateRadar({ limit: n || 80 }); }
    else if (cmd === 'poll-concalls')         { await pollConcalls(n || 100); }
    else if (cmd === 'enrich-concalls')       { await enrichConcallsBatch(n || 50); }
    else if (cmd === 'concalls')              { await pollConcalls(n || 100); await enrichConcallsBatch(n || 50); }
    else if (cmd === 'poll-macro-calendar')   { await pollMacroCalendar(); }
    else if (cmd === 'briefing-open')         { await generateBriefing('open', process.argv[3] || null); }
    else if (cmd === 'briefing-close')        { await generateBriefing('close', process.argv[3] || null); }
    else if (cmd === 'stats')                 { showStats(); }
    else {
      console.error(`Unknown command: ${cmd}`);
      console.error('Usage: node run.mjs [poll|enrich N|enrich-ids ID[,ID...]|both N|fetch-fundamentals|resolve-tijori-slugs N|generate-radar N|poll-concalls N|enrich-concalls N|concalls N|stats]');
      process.exit(1);
    }
  } catch (e) {
    try {
      updateSourceHealth(openDb(), `command_${cmd}`, { status: 'failure', error: e?.message || e });
    } catch { /* best-effort health marker */ }
    console.error('FATAL:', e);
    process.exit(1);
  }
}
