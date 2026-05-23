// Tipsheet Telegram Notifier — Cloudflare Worker
//
// Receives a POST from the pipeline with newly published articles
// and sends a formatted message to the Tipsheet Telegram channel.
//
// Env vars (set in wrangler.toml or Cloudflare dashboard):
//   BOT_TOKEN      — Telegram Bot API token from @BotFather
//   CHANNEL_ID     — Telegram channel ID or @username (e.g. @tipsheet_updates)
//   NOTIFY_SECRET  — Shared secret to verify requests from the pipeline
//   SITE_URL       — Base URL of the site (e.g. https://tipsheet.in)

const TIER_EMOJI = { Alert: '🔴', Lead: '🟡', Brief: '⚪' };
const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Format a single article into a Telegram message.
 * Uses plain text (no HTML/Markdown parse mode) to avoid escaping issues.
 */
function formatMessage(article, siteUrl) {
  const emoji = TIER_EMOJI[article.tier] || '⚪';
  const lines = [
    `${emoji} ${(article.tier || 'NOTE').toUpperCase()} · ${article.symbol || ''}`,
    '',
    article.headline || '(no headline)',
  ];

  if (article.dek) {
    lines.push(article.dek);
  }

  if (article.the_number_value) {
    lines.push('');
    lines.push(`${article.the_number_value}${article.the_number_label ? ' — ' + article.the_number_label : ''}`);
  }

  if (article.canonical_url) {
    lines.push('');
    lines.push(`→ ${siteUrl}${article.canonical_url}`);
  }

  return lines.join('\n');
}

/**
 * Send a message to the Telegram channel.
 */
async function sendTelegram(botToken, chatId, text) {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram API ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

export default {
  async fetch(request, env) {
    // Health check
    if (request.method === 'GET') {
      return new Response('Tipsheet Telegram Notifier — ok', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Verify shared secret
    const auth = request.headers.get('Authorization');
    if (!env.NOTIFY_SECRET || auth !== `Bearer ${env.NOTIFY_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const { articles } = body;
    if (!Array.isArray(articles) || articles.length === 0) {
      return new Response('No articles to notify', { status: 200 });
    }

    const siteUrl = (env.SITE_URL || 'https://tipsheet.markets').replace(/\/$/, '');
    const errors = [];
    let sent = 0;

    // Rate limit: max 10 messages per invocation to avoid Telegram throttling
    for (const article of articles.slice(0, 10)) {
      try {
        const text = formatMessage(article, siteUrl);
        await sendTelegram(env.BOT_TOKEN, env.CHANNEL_ID, text);
        sent++;
        // Telegram rate limit: max 20 messages/min to a channel.
        // 150ms delay between messages keeps us safely under.
        if (articles.length > 1) await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        errors.push({ symbol: article.symbol, error: e.message });
      }
    }

    return Response.json({
      sent,
      total: articles.length,
      capped: articles.length > 10,
      errors: errors.length ? errors : undefined,
    });
  },
};
