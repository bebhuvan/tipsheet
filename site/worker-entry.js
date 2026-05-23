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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);

    if (response.status === 404 && url.pathname !== '/') {
      return new Response('Not found', {
        status: 404,
        headers: {
          'Cache-Control': 'public, max-age=60',
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    const headers = new Headers(response.headers);

    let cc;
    for (const rule of CACHE_RULES) {
      if (rule.pattern.test(url.pathname)) {
        const extra = rule.immutable ? ', immutable' : '';
        cc = `public, max-age=${rule.maxAge}${extra}`;
        break;
      }
    }

    if (!cc && (url.pathname.endsWith('.html') || url.pathname === '/')) {
      cc = `public, max-age=${DEFAULT_PAGE_MAX_AGE}, stale-while-revalidate=3600`;
    }

    if (cc) {
      headers.set('Cache-Control', cc);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
