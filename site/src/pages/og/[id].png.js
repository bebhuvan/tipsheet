// Per-article OG image. Static-mode: one PNG per recent filing.
//
// Scale: rendering a card costs ~140ms, and at thousands of filings that
// dominates build time. A card is immutable for a given slug (headline + id),
// so we render each one once into a persisted .og-cache and reuse it on every
// later build. Cloudflare Workers' free tier also caps an asset manifest at
// 20,000 entries, so only the newest cards are shipped. The Worker serves the
// brand card for older /og/*.png URLs, keeping archived article metadata valid
// without making the asset manifest grow once per historical article.
import fs from 'node:fs';
import path from 'node:path';
import { listAllForStaticPaths, getFiling, recordIdFromSlug, tierFor } from '../../lib/queries.mjs';
import { ogSvg, renderPng } from '../../lib/og.mjs';

const OG_CACHE = path.resolve('.og-cache'); // resolved against site/ (build cwd)
const HEADERS = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' };
const MAX_STATIC_OG_CARDS = 1000;

export async function getStaticPaths() {
  return listAllForStaticPaths(MAX_STATIC_OG_CARDS).map(item => ({ params: { id: item.id } }));
}

export async function GET({ params }) {
  const cacheFile = path.join(OG_CACHE, `${params.id}.png`);
  try {
    if (fs.existsSync(cacheFile)) return new Response(fs.readFileSync(cacheFile), { headers: HEADERS });
  } catch { /* fall through to render */ }

  const recordId = recordIdFromSlug(params.id);
  const f = recordId ? getFiling(recordId) : null;
  if (!f) return new Response('Not found', { status: 404 });

  const png = renderPng(ogSvg({
    headline: f.headline,
    tier: tierFor(f.score),
    sector: f.sector || '',
    ticker: f.symbol || '',
    exchange: '',
  }));
  try { fs.mkdirSync(OG_CACHE, { recursive: true }); fs.writeFileSync(cacheFile, png); } catch { /* cache is best-effort */ }
  return new Response(png, { headers: HEADERS });
}
