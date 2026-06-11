// Shared RSS 2.0 rendering for /feed.xml and /company/[symbol]/feed.xml.
// Pure string builders — no Astro or DOM dependencies.

import { sourceLinks } from './queries.mjs';
import { renderInline, renderProse } from './prose.mjs';
import { EDITORIAL_BYLINE } from './brand.mjs';

export function escapeXml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function rfc822(iso) {
  if (!iso) return new Date().toUTCString();
  const d = new Date(String(iso).replace(' ', 'T'));
  return Number.isNaN(d.valueOf()) ? new Date().toUTCString() : d.toUTCString();
}

// Build the full-article HTML for <content:encoded>. Full-text feeds get cited
// and re-syndicated far more than dek-only teasers, and our license already
// permits attributed retrieval use.
export function filingContentHtml(f) {
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

export function filingFeedItem(f, siteUrl) {
  return {
    title: f.headline,
    url: new URL(f.canonical_url, siteUrl).toString(),
    guid: new URL(f.canonical_url, siteUrl).toString(),
    pubDate: rfc822(f.created_on),
    description: f.dek,
    content: filingContentHtml(f),
    category: f.canonical_category || 'News',
  };
}

// Render a complete RSS 2.0 document. `items` use the shape produced by
// filingFeedItem; channel metadata comes from the caller.
export function rssDocument({ title, link, selfHref, description, items }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <atom:link href="${escapeXml(selfHref)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>en-in</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map(i => `    <item>
      <title>${escapeXml(i.title)}</title>
      <link>${escapeXml(i.url)}</link>
      <guid isPermaLink="true">${escapeXml(i.guid)}</guid>
      <pubDate>${i.pubDate}</pubDate>
      <description>${escapeXml(i.description || '')}</description>${i.content ? `\n      <content:encoded><![CDATA[${String(i.content).replace(/]]>/g, ']]]]><![CDATA[>')}]]></content:encoded>` : ''}
      <category>${escapeXml(i.category)}</category>
      <dc:creator>${escapeXml(EDITORIAL_BYLINE)}</dc:creator>
    </item>`).join('\n')}
  </channel>
</rss>`;
}

export function rssResponse(body) {
  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
