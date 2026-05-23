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
  if (pathname.endsWith('.html') || pathname === '/') {
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
  async fetch(request, env) {
    const url = new URL(request.url);

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
