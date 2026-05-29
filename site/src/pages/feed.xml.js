// RSS 2.0 feed at /feed.xml. Conventional channel + items.
// Aggregators (Pulse by Zerodha, IDE agents, Mint Genie, etc.) consume this format.
// Includes the 50 most-recent Stories + the latest two briefings.

import { listFilings, listBriefings, sourceLinks } from '../lib/queries.mjs';
import { renderInline, renderProse } from '../lib/prose.mjs';
import { BRAND_NAME, BRAND_TAGLINE, BRAND_DESCRIPTION, EDITORIAL_BYLINE } from '../lib/brand.mjs';

// Build the full-article HTML for <content:encoded>. Full-text feeds get cited
// and re-syndicated far more than dek-only teasers, and our license already
// permits attributed retrieval use.
function filingContentHtml(f) {
  const src = sourceLinks(f);
  const parts = [`<p><em>${renderInline(f.dek || '')}</em></p>`];
  if (Array.isArray(f.whats_new) && f.whats_new.length) {
    parts.push('<h3>What’s new</h3><ul>' + f.whats_new.map(b => `<li>${renderInline(b)}</li>`).join('') + '</ul>');
  }
  if (f.why_it_matters) parts.push('<h3>Why it matters</h3>' + renderProse(f.why_it_matters));
  if (Array.isArray(f.what_were_watching) && f.what_were_watching.length) {
    parts.push('<h3>What we’re watching</h3><ul>' + f.what_were_watching.map(b => `<li>${renderInline(b)}</li>`).join('') + '</ul>');
  }
  if (f.the_full_read) parts.push('<h3>The full read</h3>' + renderProse(f.the_full_read));
  const verify = [src.bse_announcements && `<a href="${src.bse_announcements}">BSE</a>`, src.nse_announcements && `<a href="${src.nse_announcements}">NSE</a>`].filter(Boolean);
  if (verify.length) parts.push(`<p>Primary source: ${verify.join(' · ')}</p>`);
  return parts.join('\n');
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
function briefingPublishedIso(b) {
  return `${b.date}T${b.type === 'close' ? '16:00:00' : '08:00:00'}+05:30`;
}

export async function GET({ site }) {
  const filings = listFilings({ limit: 50 });
  const briefings = listBriefings(2);
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';

  const items = [];
  for (const b of briefings) {
    items.push({
      title: `${b.label}: ${b.headline}`,
      url: new URL(b.canonical_url, siteUrl).toString(),
      guid: new URL(b.canonical_url, siteUrl).toString(),
      pubDate: rfc822(briefingPublishedIso(b)),
      description: b.dek,
      content: [b.dek, b.the_take].filter(Boolean).map(t => `<p>${escape(t)}</p>`).join('\n') || null,
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
      content: filingContentHtml(f),
      category: f.canonical_category || 'News',
    });
  }
  // Newest first
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
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
      <description>${escape(i.description || '')}</description>${i.content ? `\n      <content:encoded><![CDATA[${String(i.content).replace(/]]>/g, ']]]]><![CDATA[>')}]]></content:encoded>` : ''}
      <category>${escape(i.category)}</category>
      <dc:creator>${escape(EDITORIAL_BYLINE)}</dc:creator>
    </item>`).join('\n')}
  </channel>
</rss>`;

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
