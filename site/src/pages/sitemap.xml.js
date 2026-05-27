// Sitemap index. Child sitemaps keep each URL set safely below protocol limits
// as the article archive grows.

import { listFilings } from '../lib/queries.mjs';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const now = new Date().toISOString();
  const filingPages = Math.max(1, Math.ceil(listFilings({ limit: 50000 }).length / 45000));
  const sitemaps = [
    '/sitemaps/static.xml',
    ...Array.from({ length: filingPages }, (_, i) => `/sitemaps/filings-${i + 1}.xml`),
    '/sitemaps/companies.xml',
    '/sitemaps/sectors.xml',
    '/sitemap-news.xml',
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemaps.map(path => `  <sitemap>
    <loc>${escapeXml(new URL(path, siteUrl).toString())}</loc>
    <lastmod>${escapeXml(now)}</lastmod>
  </sitemap>`).join('\n')}
</sitemapindex>`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
