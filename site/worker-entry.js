const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const CACHE_RULES = [
  { pattern: /^\/fonts\//,        maxAge: 31536000, immutable: true },
  { pattern: /^\/og\//,           maxAge: 86400 },
  { pattern: /^\/favicon\.svg$/,  maxAge: 31536000, immutable: true },
  { pattern: /^\/icon-.*\.png$/,  maxAge: 31536000, immutable: true },
  { pattern: /^\/apple-touch-icon\.png$/, maxAge: 31536000, immutable: true },
  { pattern: /^\/_assets\//,      maxAge: 31536000, immutable: true },
  { pattern: /^\/search-index\.json$/, maxAge: 3600 },
  { pattern: /^\/feed\.xml$/,     maxAge: 1800 },
  { pattern: /^\/feed\.json$/,    maxAge: 1800 },
  { pattern: /^\/sitemap\.xml$/,  maxAge: 3600 },
  { pattern: /^\/sitemap-news\.xml$/, maxAge: 1800 },
  { pattern: /^\/article-redirects\.json$/, maxAge: 300 },
];

const BRIEFING_BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const BRIEFING_CDN_CACHE_CONTROL = 'no-store';
const FRESH_PAGE_BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const FRESH_PAGE_CDN_CACHE_CONTROL = 'no-store';
const HTML_BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const HTML_CDN_CACHE_CONTROL = 'no-store';
const WORKER_RELEASE = '2026-05-28-no-html-cache';
const IST_OFFSET_MIN = 330;
const BRIEFING_SCHEDULES = [
  { type: 'open', dueHour: 8, dueMinute: 0, graceEnv: 'BRIEFING_OPEN_GRACE_MIN' },
  { type: 'close', dueHour: 16, dueMinute: 0, graceEnv: 'BRIEFING_CLOSE_GRACE_MIN' },
];

function applySecurityHeaders(headers) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  headers.set('Content-Security-Policy', CSP);
}

function cacheControlFor(pathname) {
  if (pathname === '/sw.js') {
    return {
      browser: 'no-cache, no-store, must-revalidate',
      cdn: 'no-store',
      cloudflareCdn: 'no-store',
      dropAssetCacheStatus: true,
    };
  }
  if (isAlwaysFreshPage(pathname)) {
    return {
      browser: FRESH_PAGE_BROWSER_CACHE_CONTROL,
      cdn: FRESH_PAGE_CDN_CACHE_CONTROL,
      cloudflareCdn: FRESH_PAGE_CDN_CACHE_CONTROL,
      dropAssetCacheStatus: true,
    };
  }
  if (/^\/briefings\/the-(open|close)\//.test(pathname)) {
    return {
      browser: BRIEFING_BROWSER_CACHE_CONTROL,
      cdn: BRIEFING_CDN_CACHE_CONTROL,
      cloudflareCdn: BRIEFING_CDN_CACHE_CONTROL,
      dropAssetCacheStatus: true,
    };
  }
  for (const rule of CACHE_RULES) {
    if (rule.pattern.test(pathname)) {
      const extra = rule.immutable ? ', immutable' : '';
      const value = `public, max-age=${rule.maxAge}${extra}`;
      return { browser: value, cdn: value, cloudflareCdn: null };
    }
  }
  // Treat clean/extensionless URLs as HTML pages. Articles are served at "/slug/"
  // (trailing slash), which matches neither ".html" nor "/", so previously they fell
  // through to null and inherited the asset server's "max-age=0, must-revalidate" —
  // forcing a revalidation on every visit. A path whose last segment has no "." is a
  // page (covers "/", "/slug/", "/slug"); real assets were already matched above.
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (pathname.endsWith('.html') || !lastSegment.includes('.')) {
    return {
      browser: HTML_BROWSER_CACHE_CONTROL,
      cdn: HTML_CDN_CACHE_CONTROL,
      cloudflareCdn: HTML_CDN_CACHE_CONTROL,
      dropAssetCacheStatus: true,
    };
  }
  return null;
}

function isAlwaysFreshPage(pathname) {
  return /^\/(?:regulation|economy)\/?$/.test(pathname);
}

function freshAssetPath(pathname) {
  if (/^\/regulation\/?$/.test(pathname)) return '/fresh/regulation/';
  if (/^\/economy\/?$/.test(pathname)) return '/fresh/economy/';
  return null;
}

function assetFetchRequest(request, pathname) {
  const freshPath = freshAssetPath(pathname);
  if (!freshPath) return request;
  const url = new URL(request.url);
  url.pathname = freshPath;
  url.search = '';
  const headers = new Headers(request.headers);
  headers.set('Cache-Control', 'no-cache');
  headers.set('Pragma', 'no-cache');
  return new Request(url.toString(), {
    method: request.method,
    headers,
    redirect: request.redirect,
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

function json(data, status = 200, maxAge = 300) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Found data is cached long (financials change slowly); a "not yet
      // available" answer is cached briefly so the box appears soon after a
      // scrape populates D1, without rebuilding or republishing the article.
      'Cache-Control': `public, max-age=${maxAge}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function redirectPath(url, pathname, status = 301) {
  const target = new URL(url);
  target.pathname = pathname;
  return Response.redirect(target.toString(), status);
}

function recordIdFromPath(pathname) {
  const clean = String(pathname || '').replace(/\/+$/, '');
  const match = clean.match(/-(\d+)$/);
  return match ? match[1] : null;
}

function istNowParts(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  const date = ist.toISOString().slice(0, 10);
  return {
    date,
    day: ist.getUTCDay(),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function istDateTimeUtcMs(dateYmd, hour, minute) {
  const [year, month, day] = dateYmd.split('-').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MIN * 60000;
}

function githubHeaders(token) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'tipsheet-cloudflare-watchdog',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function listWorkflowRuns({ repo, workflow, branch, token, perPage = 5 }) {
  const headers = githubHeaders(token);
  const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}`;
  const runsResponse = await fetch(runsUrl, { headers });
  if (!runsResponse.ok) {
    return { ok: false, status: runsResponse.status, runs: [] };
  }
  const runsBody = await runsResponse.json();
  return {
    ok: true,
    status: runsResponse.status,
    runs: Array.isArray(runsBody.workflow_runs) ? runsBody.workflow_runs : [],
  };
}

async function dispatchWorkflow({ repo, workflow, branch, token, inputs }) {
  const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const dispatchResponse = await fetch(dispatchUrl, {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: branch, inputs }),
  });
  return { ok: dispatchResponse.ok, status: dispatchResponse.status };
}

async function latestPipelineDataSuccessMs(env) {
  if (!env.tipsheet_db) return null;
  try {
    const row = await env.tipsheet_db
      .prepare(`
        SELECT MAX(last_success_at) AS last_success_at
        FROM source_health
        WHERE source IN ('filings', 'filings_enrichment')
      `)
      .first();
    const value = Number(row?.last_success_at || 0);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function maybeRedirectArticleSlug(url, env) {
  const recordId = recordIdFromPath(url.pathname);
  if (!recordId) return null;

  const redirectsUrl = new URL('/article-redirects.json', url);
  const response = await env.ASSETS.fetch(new Request(redirectsUrl.toString()));
  if (!response.ok) return null;

  let redirects = null;
  try {
    redirects = await response.json();
  } catch {
    return null;
  }

  const targetPath = redirects?.[recordId];
  if (!targetPath) return null;

  const currentPath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (currentPath === targetPath) return null;

  const target = new URL(url);
  target.pathname = targetPath;
  return Response.redirect(target.toString(), 301);
}

async function maybeDispatchGitHubWatchdog(env) {
  const token = env.GITHUB_ACTIONS_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const workflow = env.WATCHDOG_WORKFLOW || 'pipeline.yml';
  const branch = env.WATCHDOG_BRANCH || 'main';
  const maxStaleMin = Number(env.WATCHDOG_MAX_STALE_MIN || 45);
  if (!token || !repo || !maxStaleMin) return { skipped: 'missing-config' };

  const listed = await listWorkflowRuns({ repo, workflow, branch, token });
  if (!listed.ok) return { skipped: 'runs-api-failed', status: listed.status };
  const runs = listed.runs;
  if (runs.some(run => run.status === 'queued' || run.status === 'in_progress')) {
    return { skipped: 'run-active' };
  }

  const sourceHealthAt = await latestPipelineDataSuccessMs(env);
  const latestSuccess = runs.find(run => run.conclusion === 'success');
  const latestWorkflowSuccessAt = latestSuccess?.updated_at ? Date.parse(latestSuccess.updated_at) : 0;
  const latestAt = Math.max(sourceHealthAt || 0, latestWorkflowSuccessAt || 0);
  const freshness = sourceHealthAt && sourceHealthAt >= latestWorkflowSuccessAt ? 'source_health' : 'workflow_runs';
  const ageMin = latestAt ? (Date.now() - latestAt) / 60000 : Infinity;
  if (ageMin < maxStaleMin) return { skipped: 'fresh', ageMin: Math.round(ageMin), freshness };

  const dispatch = await dispatchWorkflow({
    repo,
    workflow,
    branch,
    token,
    // Fast News is ingest-only now; deploy chains via publish-site (workflow_run).
    // Only enrich_limit remains a valid input — sending skip_pipeline/skip_deploy
    // would 422 and silently break the watchdog.
    inputs: {
      enrich_limit: '50',
    },
  });
  return {
    dispatched: dispatch.ok,
    status: dispatch.status,
    ageMin: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
    freshness,
  };
}

async function briefingPageExists(env, type, date) {
  const site = String(env.SITE_URL || 'https://tipsheet.markets').replace(/\/+$/, '');
  const url = `${site}/briefings/the-${type}/${date}/`;
  const response = await fetch(url, {
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: { 'Cache-Control': 'no-cache' },
  });
  return { exists: response.status === 200, status: response.status, url };
}

async function maybeDispatchBriefingWatchdog(env) {
  const token = env.GITHUB_ACTIONS_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const workflow = env.BRIEFINGS_WORKFLOW || 'briefings.yml';
  const branch = env.WATCHDOG_BRANCH || 'main';
  if (!token || !repo) return { skipped: 'missing-config' };

  const now = istNowParts();
  if (now.day === 0 || now.day === 6) {
    return { skipped: 'weekend', date: now.date };
  }

  const due = BRIEFING_SCHEDULES
    .filter(item => {
      const graceMin = Number(env[item.graceEnv] || 15);
      const dueMinuteOfDay = item.dueHour * 60 + item.dueMinute + graceMin;
      return now.minutes >= dueMinuteOfDay;
    })
    .sort((a, b) => (b.dueHour * 60 + b.dueMinute) - (a.dueHour * 60 + a.dueMinute));
  if (!due.length) return { skipped: 'before-window', date: now.date };

  const listed = await listWorkflowRuns({ repo, workflow, branch, token, perPage: 10 });
  if (!listed.ok) return { skipped: 'runs-api-failed', status: listed.status };
  if (listed.runs.some(run => run.status === 'queued' || run.status === 'in_progress')) {
    return { skipped: 'run-active', date: now.date };
  }

  const results = [];
  for (const item of due) {
    const page = await briefingPageExists(env, item.type, now.date);
    if (page.exists) {
      results.push({ type: item.type, skipped: 'published', url: page.url });
      continue;
    }

    const dueAt = istDateTimeUtcMs(now.date, item.dueHour, item.dueMinute);
    const recentSuccess = listed.runs.find(run => (
      run.conclusion === 'success' &&
      run.created_at &&
      Date.parse(run.created_at) >= dueAt
    ));
    const deployGraceMin = Number(env.BRIEFING_DEPLOY_GRACE_MIN || 12);
    const successAgeMin = recentSuccess?.updated_at ? (Date.now() - Date.parse(recentSuccess.updated_at)) / 60000 : Infinity;
    if (recentSuccess && successAgeMin < deployGraceMin) {
      results.push({
        type: item.type,
        skipped: 'waiting-for-deploy',
        run: recentSuccess.id,
        ageMin: Math.round(successAgeMin),
        pageStatus: page.status,
        url: page.url,
      });
      continue;
    }

    const dispatch = await dispatchWorkflow({
      repo,
      workflow,
      branch,
      token,
      inputs: {
        briefing: item.type,
        date: now.date,
      },
    });
    results.push({
      type: item.type,
      dispatched: dispatch.ok,
      status: dispatch.status,
      pageStatus: page.status,
      url: page.url,
    });

    // One dispatch at a time keeps the shared DB/deploy workflow serialized.
    if (dispatch.ok) break;
  }

  return { date: now.date, results };
}

async function sendTelegramAlert(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

// Per-source alerting: any stream that explicitly recorded a failure in
// source_health (now that every ingest stream does) gets a Telegram ping, with
// a per-source cooldown so a persistent failure doesn't nag every 5-min tick.
// Alerts only on explicit status='failure' (not staleness) to avoid false
// positives across streams with different cadences — overall staleness is
// already handled by maybeDispatchGitHubWatchdog. No-op without Telegram creds.
async function maybeAlertFailedSources(env) {
  const db = env.tipsheet_db;
  if (!db) return { skipped: 'no-d1' };
  const cooldownMs = Number(env.SOURCE_ALERT_COOLDOWN_MIN || 360) * 60000;
  try {
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS watchdog_alert_state (source TEXT PRIMARY KEY, last_alert_at INTEGER)',
    ).run();
    const failed = (await db.prepare(
      "SELECT source, error FROM source_health WHERE status = 'failure'",
    ).all()).results || [];
    if (!failed.length) return { failed: 0 };

    const now = Date.now();
    const state = (await db.prepare('SELECT source, last_alert_at FROM watchdog_alert_state').all()).results || [];
    const lastAlert = Object.fromEntries(state.map(r => [r.source, Number(r.last_alert_at) || 0]));

    const alerted = [];
    for (const row of failed) {
      if (now - (lastAlert[row.source] || 0) < cooldownMs) continue;
      const ok = await sendTelegramAlert(
        env,
        `⚠️ Tipsheet source degraded: ${row.source}\n${row.error ? String(row.error).slice(0, 200) : 'recorded a failure'}`,
      );
      if (ok) {
        await db.prepare(
          'INSERT INTO watchdog_alert_state (source, last_alert_at) VALUES (?, ?) ' +
          'ON CONFLICT(source) DO UPDATE SET last_alert_at = excluded.last_alert_at',
        ).bind(row.source, now).run();
        alerted.push(row.source);
      }
    }
    return { failed: failed.length, alerted };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

function filingBuildSlug(symbol, headline, recordId) {
  const sym = String(symbol || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hd = String(headline || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return hd ? `${sym}-${hd}-${recordId}` : `${sym}-${recordId}`;
}

function filingParseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

async function handleFilingApi(pathname, env) {
  if (!pathname.startsWith('/api/filing/') || !pathname.endsWith('.json')) return null;
  if (!env.tipsheet_db) return json({ error: 'unavailable' }, 503, 0);

  const slug = pathname.slice('/api/filing/'.length, -'.json'.length);
  const idMatch = slug.match(/-(\d+)$/);
  if (!idMatch) return json({ error: 'not_found' }, 404, 60);
  const recordId = idMatch[1];

  try {
    const row = await env.tipsheet_db.prepare(`
      SELECT r.record_id, r.symbol, r.scripcode, r.company, r.score, r.sentiment,
        r.event_type, r.event_category_raw, r.event_category_canonical AS canonical_category,
        r.created_on,
        COALESCE((SELECT f.sector FROM fundamentals f WHERE f.symbol = r.symbol LIMIT 1), e.sector) AS sector,
        e.headline, e.dek, e.the_number_value, e.the_number_label,
        e.whats_new, e.why_it_matters, e.what_were_watching, e.faqs, e.the_full_read,
        e.editorial_tone, e.slug
      FROM filings_raw r
      JOIN filings_enriched e ON e.record_id = r.record_id
      WHERE r.record_id = ? AND e.validation_ok = 1
    `).bind(recordId).first();

    if (!row) return json({ error: 'not_found' }, 404, 60);

    const fund = await env.tipsheet_db.prepare(
      'SELECT market_cap, pe, roe, debt_to_equity, dividend_yield, tijori_slug FROM fundamentals WHERE symbol = ?'
    ).bind(row.symbol).first();

    const articleSlug = row.slug || filingBuildSlug(row.symbol, row.headline, row.record_id);
    const siteUrl = String(env.SITE_URL || 'https://tipsheet.markets').replace(/\/+$/, '');
    const src = {};
    if (row.scripcode) src.bse_announcements = `https://www.bseindia.com/corporates/ann.html?scrip=${row.scripcode}&dur=A`;
    if (row.symbol) src.nse_announcements = `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(row.symbol)}`;

    const theNumber = filingParseJson(row.the_number_value) !== null ? row.the_number_value : null;
    const payload = {
      publication: 'Tipsheet',
      author: { name: 'Tipsheet Editorial', url: `${siteUrl}/authors/filings-editorial/` },
      url: `${siteUrl}/${articleSlug}/`,
      id: row.record_id,
      headline: row.headline,
      dek: row.dek,
      published: String(row.created_on).replace(' ', 'T') + '+05:30',
      symbol: row.symbol,
      company: row.company,
      sector: row.sector,
      category: row.canonical_category,
      score: row.score,
      tier: row.score >= 9 ? 'Alert' : row.score >= 7 ? 'Story' : 'Update',
      the_number: row.the_number_value ? { value: row.the_number_value, label: row.the_number_label } : null,
      whats_new: filingParseJson(row.whats_new) ?? [],
      why_it_matters: row.why_it_matters,
      what_were_watching: filingParseJson(row.what_were_watching) ?? [],
      the_full_read: row.the_full_read,
      editorial_tone: row.editorial_tone,
      faqs: filingParseJson(row.faqs) ?? [],
      fundamentals: fund ? {
        market_cap: fund.market_cap, pe: fund.pe, roe: fund.roe,
        debt_to_equity: fund.debt_to_equity, dividend_yield: fund.dividend_yield,
      } : null,
      primary_sources: [src.bse_announcements, src.nse_announcements].filter(Boolean),
      research: fund?.tijori_slug ? `https://www.tijorifinance.com/company/${encodeURIComponent(fund.tijori_slug)}/` : undefined,
      license: 'Quote and cite with attribution to the canonical URL above. AI training and retrieval-augmented use permitted with attribution.',
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return json({ error: 'unavailable' }, 503, 0);
  }
}

async function handleWidgetApi(pathname, env) {
  const match = pathname.match(/^\/api\/widget\/([a-zA-Z0-9_-]+)$/);
  if (!match) return null;
  const symbol = match[1].toUpperCase();

  if (!env.tipsheet_db) return json({ symbol, available: false }, 200, 60);

  try {
    const row = await env.tipsheet_db
      .prepare('SELECT * FROM tijori_widgets WHERE symbol = ?')
      .bind(symbol)
      .first();

    if (!row) {
      return json({ symbol, available: false }, 200, 120);
    }

    return json({
      symbol: row.symbol,
      slug: row.slug,
      company_name: row.company_name,
      available: true,
      widget: JSON.parse(row.payload_json),
      fetched_at: row.fetched_at,
    }, 200, 3600);
  } catch (err) {
    return json({ symbol, error: 'unavailable' }, 500, 30);
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        maybeDispatchGitHubWatchdog(env),
        maybeDispatchBriefingWatchdog(env),
        maybeAlertFailedSources(env),
      ]).then(([pipeline, briefings, alerts]) => {
        console.log('[watchdog]', JSON.stringify({ pipeline, briefings, alerts }));
      }).catch(error => {
        console.error('[watchdog] failed:', error?.message || error);
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Retired sections → permanent redirects (the Worker handles routing, so
    // a static _redirects file wouldn't apply here).
    if (url.pathname === '/smart-money' || url.pathname === '/smart-money/') {
      return Response.redirect(new URL('/alerts/', url).toString(), 301);
    }
    if (url.pathname === '/company' || url.pathname === '/company/') {
      return redirectPath(url, '/companies/', 301);
    }
    if (url.pathname === '/sector' || url.pathname === '/sector/') {
      return redirectPath(url, '/sectors/', 301);
    }
    if (url.pathname === '/fresh/regulation' || url.pathname === '/fresh/regulation/') {
      return redirectPath(url, '/regulation/', 301);
    }
    if (url.pathname === '/fresh/economy' || url.pathname === '/fresh/economy/') {
      return redirectPath(url, '/economy/', 301);
    }
    if (
      url.pathname === '/category' ||
      url.pathname === '/category/' ||
      url.pathname === '/categories' ||
      url.pathname === '/categories/'
    ) {
      return redirectPath(url, '/filings/', 301);
    }

    const widget = await handleWidgetApi(url.pathname, env);
    if (widget) return widget;

    const filingApi = await handleFilingApi(url.pathname, env);
    if (filingApi) return filingApi;

    const response = await env.ASSETS.fetch(assetFetchRequest(request, url.pathname));

    if (response.status === 404 && url.pathname !== '/') {
      const articleRedirect = await maybeRedirectArticleSlug(url, env);
      if (articleRedirect) return articleRedirect;

      const headers = new Headers({
        'Cache-Control': 'public, max-age=60',
        'Content-Type': 'text/html; charset=utf-8',
      });
      applySecurityHeaders(headers);
      return new Response('Not found', { status: 404, headers });
    }

    const headers = new Headers(response.headers);
    applySecurityHeaders(headers);
    headers.set('X-Tipsheet-Worker-Release', WORKER_RELEASE);

    const cc = cacheControlFor(url.pathname);
    if (cc) {
      headers.set('Cache-Control', cc.browser);
      headers.set('CDN-Cache-Control', cc.cdn);
      if (cc.cloudflareCdn) headers.set('Cloudflare-CDN-Cache-Control', cc.cloudflareCdn);
      if (cc.dropAssetCacheStatus) headers.delete('CF-Cache-Status');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
