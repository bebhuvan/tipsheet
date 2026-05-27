import { distinctSymbolsWithFilings } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const urls = distinctSymbolsWithFilings().map(s => ({
    loc: new URL(`/company/${encodeURIComponent(String(s.symbol).toLowerCase())}/`, siteUrl).toString(),
    changefreq: 'daily',
    priority: '0.6',
  }));
  return xmlResponse(urlset(urls));
}
