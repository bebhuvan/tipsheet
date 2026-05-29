// Push newly-published articles to a Telegram channel via the Bot API.
// Runs after the enrich step in CI. Idempotent: each article is sent at most
// once (tracked by filings_enriched.notified_at), so re-runs never duplicate.
//
// Required env (GitHub Actions secrets):
//   TELEGRAM_BOT_TOKEN   from @BotFather
//   TELEGRAM_CHAT_ID     the channel/chat id (e.g. @yourchannel or -100…)
// Optional:
//   SITE_URL             defaults to https://tipsheet.markets
//   NOTIFY_SCORE_MIN     minimum score to push (default 5)
//   TELEGRAM_DELIVERY_MODE digest | individual (default digest)
import { buildArticleSlug, openDb } from './db.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const SITE = (process.env.SITE_URL || 'https://tipsheet.markets').replace(/\/+$/, '');
const SCORE_MIN = Number(process.env.NOTIFY_SCORE_MIN || 5);
const MAX_PER_RUN = 15;
const BACKLOG_KEEP_LATEST = 20;
const DELIVERY_MODE = (process.env.TELEGRAM_DELIVERY_MODE || 'digest').toLowerCase();
const REQUIRE_LIVE_URL = process.env.TELEGRAM_REQUIRE_LIVE_URL !== '0';

const DEFAULT_LLM_BASE = process.env.DEEPSEEK_API_KEY
  ? 'https://api.deepseek.com'
  : 'https://generativelanguage.googleapis.com/v1beta/openai';
const LLM = {
  baseUrl: process.env.TELEGRAM_LLM_BASE_URL || process.env.LLM_BASE_URL || DEFAULT_LLM_BASE,
  apiKey: process.env.TELEGRAM_LLM_API_KEY || process.env.LLM_API_KEY || process.env.GOOGLE_API_KEY || process.env.DEEPSEEK_API_KEY,
  model: process.env.TELEGRAM_LLM_MODEL || process.env.LLM_MODEL || (process.env.DEEPSEEK_API_KEY ? 'deepseek-v4-flash' : 'gemini-3.1-flash-lite'),
};

if (!TOKEN || !CHAT) {
  console.log('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping');
  process.exit(0);
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tierFor = (s) => (s >= 9 ? '🔴 Alert' : s >= 7 ? '🟠 Lead' : '⚪️ Brief');
const plainTierFor = (s) => (s >= 9 ? 'Alert' : s >= 7 ? 'Lead' : 'Brief');
const trimText = (s, n = 280) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1).trim()}…` : text;
};
const capTierFor = (marketCap) => {
  const v = Number(marketCap);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 100000) return 'mega cap';
  if (v >= 20000) return 'large cap';
  if (v >= 5000) return 'mid cap';
  if (v >= 1000) return 'small cap';
  return 'micro cap';
};

async function send(html) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  if (!r.ok) {
    // Surface the API error text but never the token.
    const detail = await r.text().catch(() => '');
    throw new Error(`Telegram API ${r.status}: ${detail.slice(0, 200)}`);
  }
}

async function urlIsLive(url) {
  if (!REQUIRE_LIVE_URL) return true;
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function briefingDate(ymd) {
  const m = String(ymd || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${+m[3]} ${monthsShort[+m[2] - 1]}` : String(ymd || '');
}

// Pull the event companies (symbol + filing headline) behind a briefing, in order.
function resolveBriefingEvents(db, sectionsJson) {
  let body = {};
  try { body = JSON.parse(sectionsJson || '{}'); } catch { /* ignore */ }
  const events = Array.isArray(body?.events) ? body.events : [];
  const ids = [...new Set(events.map(e => Number(e?.filing_id)).filter(Number.isFinite))];
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT r.record_id, r.symbol, e.headline
       FROM filings_raw r JOIN filings_enriched e ON e.record_id = r.record_id
      WHERE r.record_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const byId = new Map(rows.map(r => [Number(r.record_id), r]));
  return events.map(e => byId.get(Number(e?.filing_id))).filter(Boolean);
}

function buildBriefingMessage(b, events) {
  const label = b.type === 'open' ? 'The Open' : 'The Close';
  const emoji = b.type === 'open' ? '🌅' : '🔔';
  const url = `${SITE}/briefings/the-${b.type}/${b.date}/`;
  let msg = `${emoji} <b>${escapeHtml(label)}</b> · ${escapeHtml(briefingDate(b.date))}\n\n`;
  msg += `<b>${escapeHtml(b.headline)}</b>\n`;
  if (b.dek) msg += `${escapeHtml(b.dek)}\n`;
  if (b.the_take) msg += `\n<i>${escapeHtml(b.the_take)}</i>\n`;
  if (events.length) {
    msg += `\n<b>What moved</b>\n`;
    for (const e of events.slice(0, 6)) msg += `• <b>${escapeHtml(e.symbol)}</b> — ${escapeHtml(e.headline)}\n`;
    if (events.length > 6) msg += `…and ${events.length - 6} more\n`;
  }
  msg += `\n<a href="${escapeHtml(url)}">Read the full digest →</a>`;
  return msg;
}

function articleUrl(r) {
  return `${SITE}/${r.slug || buildArticleSlug(r.symbol, r.headline, r.record_id)}/`;
}

async function filterLiveArticleRows(rows, TEST) {
  if (TEST || !REQUIRE_LIVE_URL) return rows;
  const checked = await Promise.all(rows.map(async (row) => {
    const url = articleUrl(row);
    return { row, url, live: await urlIsLive(url) };
  }));
  const skipped = checked.filter(item => !item.live);
  for (const item of skipped) {
    console.warn(`[telegram] skip ${item.row.record_id}: URL not live after deploy: ${item.url}`);
  }
  return checked.filter(item => item.live).map(item => item.row);
}

function buildFallbackDigest(rows) {
  const alerts = rows.filter(r => r.score >= 9).length;
  const leads = rows.filter(r => r.score >= 7 && r.score < 9).length;
  let msg = `🧾 <b>Tipsheet digest</b> · ${rows.length} new ${rows.length === 1 ? 'note' : 'notes'}\n`;
  msg += `${alerts} alerts · ${leads} leads · score ≥ ${SCORE_MIN}\n\n`;
  for (const r of rows.slice(0, 8)) {
    const cat = r.canonical_category && r.canonical_category !== 'Other' ? ` · ${escapeHtml(r.canonical_category)}` : '';
    msg += `${tierFor(r.score)} · <b>${escapeHtml(r.symbol)}</b>${cat}\n`;
    msg += `${escapeHtml(r.headline)}\n`;
    if (r.dek) msg += `<i>${escapeHtml(r.dek)}</i>\n`;
    msg += `<a href="${escapeHtml(articleUrl(r))}">Read →</a>\n\n`;
  }
  if (rows.length > 8) msg += `…and ${rows.length - 8} more on Tipsheet.\n\n`;
  msg += `<a href="${SITE}/filings/">Open the full archive →</a>`;
  return msg.slice(0, 3900);
}

async function buildAiDigest(rows) {
  if (!LLM.apiKey) return null;
  const compact = rows.slice(0, MAX_PER_RUN).map(r => ({
    symbol: r.symbol,
    company: r.company,
    score: r.score,
    tier: plainTierFor(r.score),
    category: r.canonical_category,
    sector: r.sector,
    market_cap_tier: capTierFor(r.market_cap),
    market_cap_cr: Number.isFinite(Number(r.market_cap)) ? Number(r.market_cap) : null,
    headline: trimText(r.headline, 180),
    dek: trimText(r.dek, 220),
    number: r.the_number_value ? {
      value: r.the_number_value,
      label: r.the_number_label || '',
    } : null,
    why_it_matters: trimText(r.why_it_matters, 280),
    url: articleUrl(r),
  }));

  const messages = [
    {
      role: 'system',
      content: [
        'You write one Telegram digest for Tipsheet, an Indian-equities filings publication.',
        'This is a desk note, not a headline dump. The reader should know the lead item, the pattern across the refresh, and which filings deserve a click.',
        'Use only the supplied fields. No invented facts, numbers, prices, market reaction, analyst views, or sector context.',
        'Rank by reader importance, not by score alone: material large/mid-cap developments first; forensic governance, large orders relative to market cap, funding stress, guidance changes and promoter/control events can outrank routine earnings. Micro-caps need a specific reason to make the cut.',
        'The headline should frame the refresh, not say "Tipsheet digest". The take should connect two or three threads across the list in one or two plain sentences.',
        'Each item line must name what changed and why it matters. Use the number or market-cap tier when it sharpens the read. Do not repeat the headline verbatim.',
        'Style: FT Lex / markets desk. Plain English, active voice, no hype, no filler, no "investors will", no "underscores/highlights/showcases", no "robust/significant/transformative", no wrap words like overall/ultimately.',
        'Return JSON only: {"headline":"string","take":"string","items":[{"symbol":"string","line":"string","url":"string"}]}',
        'Limits: headline <= 68 chars. take <= 260 chars. items 5-8 unless fewer supplied. line <= 175 chars. Order items by importance.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `New filings since the last refresh:\n${JSON.stringify(compact)}`,
    },
  ];

  try {
    const r = await fetch(`${LLM.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LLM.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.45,
        max_tokens: 1100,
      }),
    });
    if (!r.ok) return null;
    const body = await r.json();
    const content = body.choices?.[0]?.message?.content || '';
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(content.slice(start, end + 1));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (!items.length) return null;

    let msg = `🧾 <b>${escapeHtml(parsed.headline || 'Tipsheet digest')}</b>\n`;
    if (parsed.take) msg += `${escapeHtml(parsed.take)}\n`;
    msg += `\n`;
    for (const item of items.slice(0, 8)) {
      const row = rows.find(r => r.symbol === item.symbol) || null;
      const url = item.url || (row ? articleUrl(row) : `${SITE}/filings/`);
      msg += `• <b>${escapeHtml(item.symbol || row?.symbol || '')}</b> — ${escapeHtml(item.line || row?.headline || '')}\n`;
      msg += `<a href="${escapeHtml(url)}">Read →</a>\n`;
    }
    msg += `\n<a href="${SITE}/filings/">All new notes →</a>`;
    return msg.slice(0, 3900);
  } catch {
    return null;
  }
}

async function notifyArticleDigest(db, rows, TEST) {
  rows = await filterLiveArticleRows(rows, TEST);
  if (!rows.length) {
    console.log('[telegram] no live article URLs to notify; rows left un-notified');
    return;
  }
  const text = await buildAiDigest(rows) || buildFallbackDigest(rows);
  await send(TEST ? `🧪 <i>Test digest</i>\n\n${text}` : text);
  if (!TEST) {
    const mark = db.prepare('UPDATE filings_enriched SET notified_at = ? WHERE record_id = ?');
    const now = Date.now();
    for (const r of rows) mark.run(now, r.record_id);
  }
  console.log(`[telegram] digest sent for ${rows.length} article(s)${LLM.apiKey ? ' (AI attempted)' : ' (fallback)'}`);
}

// Push newly-published briefings (The Open / The Close). Idempotent via
// briefings.notified_at, with the same back-catalogue guard as articles.
async function notifyBriefings(db, TEST) {
  let columnAdded = false;
  try { db.prepare('ALTER TABLE briefings ADD COLUMN notified_at INTEGER').run(); columnAdded = true; } catch { /* exists */ }
  if (columnAdded && !TEST) {
    db.prepare(`
      UPDATE briefings
         SET notified_at = ?
       WHERE notified_at IS NULL
         AND (type || ':' || date) NOT IN (
           SELECT type || ':' || date
             FROM briefings
            WHERE validation_ok = 1
            ORDER BY generated_at DESC
            LIMIT 2
         )
    `).run(Date.now());
    console.log('[telegram] briefings: first run — older back-catalogue marked notified');
  }

  const rows = TEST
    ? db.prepare(`SELECT type, date, headline, dek, the_take, sections FROM briefings
                  WHERE validation_ok = 1 ORDER BY generated_at DESC LIMIT 1`).all()
    : db.prepare(`SELECT type, date, headline, dek, the_take, sections FROM briefings
                  WHERE validation_ok = 1 AND notified_at IS NULL
                  ORDER BY date ASC, generated_at ASC LIMIT 4`).all();
  if (!rows.length) { console.log('[telegram] no new briefings'); return; }

  const mark = db.prepare('UPDATE briefings SET notified_at = ? WHERE type = ? AND date = ?');
  let sent = 0;
  for (const b of rows) {
    const events = resolveBriefingEvents(db, b.sections);
    try {
      const text = buildBriefingMessage(b, events);
      const url = `${SITE}/briefings/the-${b.type}/${b.date}/`;
      if (!TEST && !(await urlIsLive(url))) {
        console.warn(`[telegram] briefing skip ${b.type}:${b.date}: URL not live after deploy: ${url}`);
        continue;
      }
      await send(TEST ? `🧪 <i>Test digest</i>\n\n${text}` : text);
      if (!TEST) mark.run(Date.now(), b.type, b.date);
      sent++;
      await new Promise((res) => setTimeout(res, 1200));
    } catch (e) {
      console.error('[telegram] briefing send failed:', e.message);
      break;
    }
  }
  console.log(`[telegram] briefings sent ${sent}/${rows.length}`);
}

async function main() {
  const TEST = process.argv.includes('--test');
  const SCOPE = (process.env.TELEGRAM_SCOPE || 'all').toLowerCase();
  const db = openDb();

  const sendBriefings = SCOPE === 'all' || SCOPE === 'briefings';
  const sendArticles = SCOPE === 'all' || SCOPE === 'articles';
  if (!sendBriefings && !sendArticles) {
    throw new Error(`Invalid TELEGRAM_SCOPE "${SCOPE}". Use all, briefings, or articles.`);
  }

  // Briefings first — they're the day's summary, ahead of individual article pushes.
  if (sendBriefings) await notifyBriefings(db, TEST);
  if (!sendArticles) return;

  // notified_at marks articles already pushed. Add the column if an older DB
  // predates it (SQLite has no ADD COLUMN IF NOT EXISTS).
  let columnAdded = false;
  try { db.prepare('ALTER TABLE filings_enriched ADD COLUMN notified_at INTEGER').run(); columnAdded = true; } catch { /* exists */ }

  // First time the column appears, mark older back-catalogue as already
  // notified so we don't flood the channel, but keep the newest eligible
  // rows available for the first channel push.
  if (columnAdded && !TEST) {
    db.prepare(`
      UPDATE filings_enriched
         SET notified_at = ?
       WHERE notified_at IS NULL
         AND record_id NOT IN (
           SELECT e.record_id
             FROM filings_enriched e
             JOIN filings_raw r ON r.record_id = e.record_id
            WHERE e.validation_ok = 1
              AND r.score >= ?
            ORDER BY e.enriched_at DESC
            LIMIT ?
         )
    `).run(Date.now(), SCORE_MIN, BACKLOG_KEEP_LATEST);
    console.log(`[telegram] first run — older back-catalogue marked notified; latest ${BACKLOG_KEEP_LATEST} remain eligible`);
  }

  const rows = TEST
    ? db.prepare(`
        SELECT r.symbol, r.company, r.score, r.record_id,
               e.headline, e.dek, e.the_number_value, e.the_number_label,
               e.why_it_matters, e.canonical_category, e.sector, e.slug,
               f.market_cap
        FROM filings_enriched e
        JOIN filings_raw r ON r.record_id = e.record_id
        LEFT JOIN fundamentals f ON f.symbol = r.symbol
        WHERE e.validation_ok = 1
        ORDER BY e.enriched_at DESC
        LIMIT 1
      `).all()
    : db.prepare(`
        SELECT r.symbol, r.company, r.score, r.record_id,
               e.headline, e.dek, e.the_number_value, e.the_number_label,
               e.why_it_matters, e.canonical_category, e.sector, e.slug,
               f.market_cap
        FROM filings_enriched e
        JOIN filings_raw r ON r.record_id = e.record_id
        LEFT JOIN fundamentals f ON f.symbol = r.symbol
        WHERE e.validation_ok = 1 AND e.notified_at IS NULL AND r.score >= ?
        ORDER BY e.enriched_at ASC
        LIMIT ?
      `).all(SCORE_MIN, MAX_PER_RUN);

  if (!rows.length) { console.log('[telegram] nothing new to notify'); return; }

  if (DELIVERY_MODE === 'digest') {
    await notifyArticleDigest(db, rows, TEST);
    return;
  }
  if (DELIVERY_MODE !== 'individual') {
    throw new Error(`Invalid TELEGRAM_DELIVERY_MODE "${DELIVERY_MODE}". Use digest or individual.`);
  }

  const mark = db.prepare('UPDATE filings_enriched SET notified_at = ? WHERE record_id = ?');
  let sent = 0;
  const liveRows = await filterLiveArticleRows(rows, TEST);
  if (!liveRows.length) {
    console.log('[telegram] no live article URLs to notify; rows left un-notified');
    return;
  }
  for (const r of liveRows) {
    const url = articleUrl(r);
    const cat = r.canonical_category && r.canonical_category !== 'Other' ? ` · ${escapeHtml(r.canonical_category)}` : '';
    const number = r.the_number_value ? `\n<b>${escapeHtml(r.the_number_value)}</b>${r.the_number_label ? ' ' + escapeHtml(r.the_number_label) : ''}` : '';
    const text =
      `${tierFor(r.score)} · <b>${escapeHtml(r.symbol)}</b>${cat}\n\n` +
      `<b>${escapeHtml(r.headline)}</b>\n` +
      (r.dek ? `${escapeHtml(r.dek)}\n` : '') +
      number +
      `\n\n<a href="${escapeHtml(url)}">Read on Tipsheet →</a>`;
    try {
      await send(TEST ? `🧪 <i>Test message</i>\n\n${text}` : text);
      if (!TEST) mark.run(Date.now(), r.record_id);
      sent++;
      await new Promise((res) => setTimeout(res, 1200)); // stay under Telegram rate limits
    } catch (e) {
      console.error('[telegram] send failed:', e.message);
      break; // stop on first failure; unsent rows stay un-notified for the next run
    }
  }
  console.log(`[telegram] sent ${sent}/${rows.length}`);
}

main().catch((e) => { console.error('[telegram] FAIL:', e.message); process.exit(1); });
