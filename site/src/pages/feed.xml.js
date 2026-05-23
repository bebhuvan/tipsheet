// RSS 2.0 feed at /feed.xml. Conventional channel + items.
// Aggregators (Pulse by Zerodha, IDE agents, Mint Genie, etc.) consume this format.
// Includes the 50 most-recent Stories + the latest two briefings.

import { listFilings, listBriefings } from '../lib/queries.mjs';
import { BRAND_NAME, BRAND_TAGLINE, BRAND_DESCRIPTION, EDITORIAL_BYLINE } from '../lib/brand.mjs';

function escape(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function rfc822(iso) {
  if (!iso) return new Date().toUTCString();
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.valueOf()) ? new Date().toUTCString() : d.toUTCString();
}

export async function GET({ site }) {
  const filings = listFilings({ limit: 50 });
  const briefings = listBriefings(2);
  const siteUrl = site?.toString() || 'https://filings.in/';

  const items = [];
  for (const b of briefings) {
    items.push({
      title: `${b.label}: ${b.headline}`,
      url: new URL(b.canonical_url, siteUrl).toString(),
      guid: new URL(b.canonical_url, siteUrl).toString(),
      pubDate: rfc822(b.date + 'T03:15:00+05:30'),
      description: b.dek,
      category: 'Briefings',
    });
  }
  for (const f of filings) {
    items.push({
      title: f.headline,
      url: new URL(f.canonical_url, siteUrl).toString(),
      guid: new URL(f.canonical_url, siteUrl).toString(),
      pubDate: rfc822(f.created_on),
      description: f.dek,
      category: f.canonical_category || 'News',
    });
  }
  // Newest first
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escape(BRAND_NAME)} — ${escape(BRAND_TAGLINE.replace(/\.$/, ''))}</title>
    <link>${escape(siteUrl)}</link>
    <atom:link href="${escape(new URL('/feed.xml', siteUrl).toString())}" rel="self" type="application/rss+xml" />
    <description>${escape(BRAND_DESCRIPTION)}</description>
    <language>en-in</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map(i => `    <item>
      <title>${escape(i.title)}</title>
      <link>${escape(i.url)}</link>
      <guid isPermaLink="true">${escape(i.guid)}</guid>
      <pubDate>${i.pubDate}</pubDate>
      <description>${escape(i.description || '')}</description>
      <category>${escape(i.category)}</category>
      <dc:creator>${escape(EDITORIAL_BYLINE)}</dc:creator>
    </item>`).join('\n')}
  </channel>
</rss>`;

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
