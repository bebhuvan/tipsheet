import { listSyntheses } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const urls = listSyntheses({ limit: 5000 }).map(p => ({
    loc: new URL(p.canonical_url, siteUrl).toString(),
    lastmod: p.generated_at ? new Date(p.generated_at).toISOString() : undefined,
    changefreq: 'monthly',
    priority: '0.8',
  }));
  return xmlResponse(urlset(urls));
}
