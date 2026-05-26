// Google News–specific sitemap. Only filings from the last 48 hours per Google's spec.
// https://developers.google.com/search/docs/specialty/news/news-sitemaps

import { listFilings } from '../lib/queries.mjs';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value) {
  return String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const all = listFilings({ limit: 1000 });
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = all.filter(f => {
    const t = new Date(String(f.created_on).replace(' ', 'T')).valueOf();
    return !isNaN(t) && t >= cutoff;
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${recent.map(f => `  <url>
    <loc>${escapeXml(new URL(f.canonical_url, siteUrl).toString())}</loc>
    <news:news>
      <news:publication>
        <news:name>Tipsheet</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${escapeXml(String(f.created_on).replace(' ', 'T') + '+05:30')}</news:publication_date>
      <news:title><![CDATA[${cdata(f.headline)}]]></news:title>
      <news:keywords>${escapeXml([f.symbol, f.company, f.canonical_category, f.sector].filter(Boolean).join(', '))}</news:keywords>
    </news:news>
  </url>`).join('\n')}
</urlset>`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
