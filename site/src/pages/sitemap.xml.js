// Standard XML sitemap — every public URL.
// Built statically at build-time.

import { listFilings, distinctSymbolsWithFilings, distinctSectorsWithFilings, sectorSlug, MARKET_CAP_TIERS } from '../lib/queries.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const filings = listFilings({ limit: 50000 });
  const symbols = distinctSymbolsWithFilings();
  const sectors = distinctSectorsWithFilings();

  const urls = [
    { loc: `${siteUrl}/`,             changefreq: 'hourly', priority: '1.0' },
    { loc: `${siteUrl}/filings/`,      changefreq: 'hourly', priority: '0.9' },
    { loc: `${siteUrl}/radar/`,        changefreq: 'hourly', priority: '0.8' },
    { loc: `${siteUrl}/markets/`,      changefreq: 'hourly', priority: '0.8' },
    { loc: `${siteUrl}/concalls/`,     changefreq: 'daily',  priority: '0.7' },
    { loc: `${siteUrl}/orders/`,       changefreq: 'daily',  priority: '0.7' },
    { loc: `${siteUrl}/smart-money/`,  changefreq: 'daily',  priority: '0.7' },
    { loc: `${siteUrl}/methodology/`,  changefreq: 'monthly', priority: '0.4' },
  ];
  for (const cat of ['earnings','concalls','order-wins','m-a','credit','regulatory']) {
    urls.push({ loc: `${siteUrl}/filings/category/${cat}/`, changefreq: 'daily', priority: '0.6' });
  }
  for (const tier of MARKET_CAP_TIERS) {
    urls.push({ loc: `${siteUrl}/filings/market-cap/${tier.slug}/`, changefreq: 'daily', priority: '0.6' });
  }
  for (const f of filings) {
    urls.push({
      loc: `${siteUrl}${f.canonical_url}`,
      lastmod: String(f.created_on).replace(' ', 'T') + '+05:30',
      changefreq: 'monthly',
      priority: '0.7',
    });
  }
  for (const s of symbols) {
    urls.push({
      loc: `${siteUrl}/company/${String(s.symbol).toLowerCase()}/`,
      changefreq: 'daily',
      priority: '0.6',
    });
  }
  for (const s of sectors) {
    urls.push({
      loc: `${siteUrl}/sector/${sectorSlug(s.sector)}/`,
      changefreq: 'daily',
      priority: '0.5',
    });
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
