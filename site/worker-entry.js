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
];

const DEFAULT_PAGE_MAX_AGE = 300;

function applySecurityHeaders(headers) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  headers.set('Content-Security-Policy', CSP);
}

function cacheControlFor(pathname) {
  for (const rule of CACHE_RULES) {
    if (rule.pattern.test(pathname)) {
      const extra = rule.immutable ? ', immutable' : '';
      return `public, max-age=${rule.maxAge}${extra}`;
    }
  }
  // Treat clean/extensionless URLs as HTML pages. Articles are served at "/slug/"
  // (trailing slash), which matches neither ".html" nor "/", so previously they fell
  // through to null and inherited the asset server's "max-age=0, must-revalidate" —
  // forcing a revalidation on every visit. A path whose last segment has no "." is a
  // page (covers "/", "/slug/", "/slug"); real assets were already matched above.
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (pathname.endsWith('.html') || !lastSegment.includes('.')) {
    return `public, max-age=${DEFAULT_PAGE_MAX_AGE}, stale-while-revalidate=3600`;
  }
  return null;
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

async function maybeDispatchGitHubWatchdog(env) {
  const token = env.GITHUB_ACTIONS_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const workflow = env.WATCHDOG_WORKFLOW || 'pipeline.yml';
  const branch = env.WATCHDOG_BRANCH || 'main';
  const maxStaleMin = Number(env.WATCHDOG_MAX_STALE_MIN || 45);
  if (!token || !repo || !maxStaleMin) return { skipped: 'missing-config' };

  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'tipsheet-cloudflare-watchdog',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=5`;
  const runsResponse = await fetch(runsUrl, { headers });
  if (!runsResponse.ok) return { skipped: 'runs-api-failed', status: runsResponse.status };
  const runsBody = await runsResponse.json();
  const runs = Array.isArray(runsBody.workflow_runs) ? runsBody.workflow_runs : [];
  if (runs.some(run => run.status === 'queued' || run.status === 'in_progress')) {
    return { skipped: 'run-active' };
  }

  const latestSuccess = runs.find(run => run.conclusion === 'success');
  const latestAt = latestSuccess?.updated_at ? Date.parse(latestSuccess.updated_at) : 0;
  const ageMin = latestAt ? (Date.now() - latestAt) / 60000 : Infinity;
  if (ageMin < maxStaleMin) return { skipped: 'fresh', ageMin: Math.round(ageMin) };

  const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const dispatchResponse = await fetch(dispatchUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: branch,
      inputs: {
        skip_pipeline: 'false',
        skip_deploy: 'false',
        enrich_limit: '50',
      },
    }),
  });
  return {
    dispatched: dispatchResponse.ok,
    status: dispatchResponse.status,
    ageMin: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
  };
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
      maybeDispatchGitHubWatchdog(env).then(result => {
        console.log('[watchdog]', JSON.stringify(result));
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

    const response = await env.ASSETS.fetch(request);

    if (response.status === 404 && url.pathname !== '/') {
      const headers = new Headers({
        'Cache-Control': 'public, max-age=60',
        'Content-Type': 'text/html; charset=utf-8',
      });
      applySecurityHeaders(headers);
      return new Response('Not found', { status: 404, headers });
    }

    const headers = new Headers(response.headers);
    applySecurityHeaders(headers);

    const cc = cacheControlFor(url.pathname);
    if (cc) {
      headers.set('Cache-Control', cc);
      headers.set('CDN-Cache-Control', cc);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
