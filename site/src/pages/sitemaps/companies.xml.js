import { distinctSymbolsWithFilings, listAllCompanies } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  // Map symbol → latest filing timestamp so each company page carries an honest
  // lastmod (concall-only companies have no filing date and simply omit it).
  const latestBySymbol = new Map(
    listAllCompanies()
      .filter(c => c.latest)
      .map(c => [String(c.symbol).toUpperCase(), String(c.latest).replace(' ', 'T') + '+05:30'])
  );
  const urls = distinctSymbolsWithFilings().map(s => ({
    loc: new URL(`/company/${encodeURIComponent(String(s.symbol).toLowerCase())}/`, siteUrl).toString(),
    lastmod: latestBySymbol.get(String(s.symbol).toUpperCase()),
    changefreq: 'daily',
    priority: '0.6',
  }));
  return xmlResponse(urlset(urls));
}
