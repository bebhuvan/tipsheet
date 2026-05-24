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
import { openDb } from './db.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const SITE = (process.env.SITE_URL || 'https://tipsheet.markets').replace(/\/+$/, '');
const SCORE_MIN = Number(process.env.NOTIFY_SCORE_MIN || 5);
const MAX_PER_RUN = 15;

if (!TOKEN || !CHAT) {
  console.log('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping');
  process.exit(0);
}

function buildSlug(symbol, headline, recordId) {
  const sym = String(symbol || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hd = String(headline || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return hd ? `${sym}-${hd}-${recordId}` : `${sym}-${recordId}`;
}
const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tierFor = (s) => (s >= 9 ? '🔴 Alert' : s >= 7 ? '🟠 Lead' : '⚪️ Brief');

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

// Push newly-published briefings (The Open / The Close). Idempotent via
// briefings.notified_at, with the same back-catalogue guard as articles.
async function notifyBriefings(db, TEST) {
  let columnAdded = false;
  try { db.prepare('ALTER TABLE briefings ADD COLUMN notified_at INTEGER').run(); columnAdded = true; } catch { /* exists */ }
  if (columnAdded && !TEST) {
    db.prepare('UPDATE briefings SET notified_at = ? WHERE notified_at IS NULL').run(Date.now());
    console.log('[telegram] briefings: first run — back-catalogue marked notified');
    return;
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
  const db = openDb();

  // Briefings first — they're the day's summary, ahead of individual article pushes.
  await notifyBriefings(db, TEST);
  // notified_at marks articles already pushed. Add the column if an older DB
  // predates it (SQLite has no ADD COLUMN IF NOT EXISTS).
  let columnAdded = false;
  try { db.prepare('ALTER TABLE filings_enriched ADD COLUMN notified_at INTEGER').run(); columnAdded = true; } catch { /* exists */ }

  // First time the column appears, mark the whole back-catalogue as already
  // notified so we don't flood the channel with hundreds of old articles.
  // Only genuinely new articles (enriched after this point) get pushed.
  if (columnAdded && !TEST) {
    db.prepare('UPDATE filings_enriched SET notified_at = ? WHERE notified_at IS NULL').run(Date.now());
    console.log('[telegram] first run — back-catalogue marked as notified; only new articles push from now on');
    return;
  }

  const rows = TEST
    ? db.prepare(`
        SELECT r.symbol, r.company, r.score, r.record_id,
               e.headline, e.dek, e.the_number_value, e.the_number_label, e.canonical_category
        FROM filings_enriched e
        JOIN filings_raw r ON r.record_id = e.record_id
        WHERE e.validation_ok = 1
        ORDER BY e.enriched_at DESC
        LIMIT 1
      `).all()
    : db.prepare(`
        SELECT r.symbol, r.company, r.score, r.record_id,
               e.headline, e.dek, e.the_number_value, e.the_number_label, e.canonical_category
        FROM filings_enriched e
        JOIN filings_raw r ON r.record_id = e.record_id
        WHERE e.validation_ok = 1 AND e.notified_at IS NULL AND r.score >= ?
        ORDER BY e.enriched_at ASC
        LIMIT ?
      `).all(SCORE_MIN, MAX_PER_RUN);

  if (!rows.length) { console.log('[telegram] nothing new to notify'); return; }

  const mark = db.prepare('UPDATE filings_enriched SET notified_at = ? WHERE record_id = ?');
  let sent = 0;
  for (const r of rows) {
    const url = `${SITE}/${buildSlug(r.symbol, r.headline, r.record_id)}/`;
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

main().catch((e) => { console.error('[telegram] FAIL:', e.message); process.exit(0); });
