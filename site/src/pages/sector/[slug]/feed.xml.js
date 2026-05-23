// Per-sector RSS 2.0 feed at /sector/[slug]/feed.xml.

import { distinctSectorsWithFilings, sectorBySlug, sectorSlug, filingsForSector } from '../../../lib/queries.mjs';
import { BRAND_NAME, EDITORIAL_BYLINE } from '../../../lib/brand.mjs';

export async function getStaticPaths() {
  return distinctSectorsWithFilings().map(s => ({ params: { slug: sectorSlug(s.sector) } }));
}

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rfc822(iso) {
  if (!iso) return new Date().toUTCString();
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.valueOf()) ? new Date().toUTCString() : d.toUTCString();
}

export async function GET({ params, site }) {
  const { slug } = params;
  const sector = sectorBySlug(slug);
  if (!sector) return new Response('Sector not found', { status: 404 });
  const filings = filingsForSector(sector, 50);
  const siteUrl = site?.toString() || 'https://filings.in/';
  const feedUrl = new URL(`/sector/${slug}/feed.xml`, siteUrl).toString();

  const items = filings.map(f => `    <item>
      <title>${escape(f.headline)}</title>
      <link>${escape(new URL(f.canonical_url, siteUrl).toString())}</link>
      <guid isPermaLink="true">${escape(new URL(f.canonical_url, siteUrl).toString())}</guid>
      <pubDate>${rfc822(f.created_on)}</pubDate>
      <description>${escape(f.dek || '')}</description>
      <category>${escape(f.canonical_category || 'News')}</category>
      <dc:creator>${escape(EDITORIAL_BYLINE)}</dc:creator>
    </item>`).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escape(sector)} sector — ${escape(BRAND_NAME)}</title>
    <link>${escape(new URL(`/sector/${slug}/`, siteUrl).toString())}</link>
    <atom:link href="${escape(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>Every ${escape(EDITORIAL_BYLINE)} note in the ${escape(sector)} sector, newest first.</description>
    <language>en-in</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
