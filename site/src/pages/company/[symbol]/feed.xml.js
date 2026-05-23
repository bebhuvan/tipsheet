// Per-company RSS 2.0 feed at /company/[symbol]/feed.xml.
// One feed per company covered. Useful for: journalists tracking a single ticker,
// aggregators (Pulse by Zerodha, Mint Genie etc.) republishing per-company news,
// IDE / LLM agents pulling structured company history.

import { distinctSymbolsWithFilings, filingsForCompany } from '../../../lib/queries.mjs';
import { BRAND_NAME, EDITORIAL_BYLINE } from '../../../lib/brand.mjs';

export async function getStaticPaths() {
  return distinctSymbolsWithFilings().map(s => ({ params: { symbol: String(s.symbol).toLowerCase() } }));
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
  const { symbol } = params;
  const SYMBOL = String(symbol).toUpperCase();
  const filings = filingsForCompany(SYMBOL, 50);
  const siteUrl = site?.toString() || 'https://filings.in/';
  const companyName = filings[0]?.company || SYMBOL;
  const feedUrl = new URL(`/company/${symbol}/feed.xml`, siteUrl).toString();

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
    <title>${escape(companyName)} (${escape(SYMBOL)}) — ${escape(BRAND_NAME)}</title>
    <link>${escape(new URL(`/company/${symbol}/`, siteUrl).toString())}</link>
    <atom:link href="${escape(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>Every ${escape(EDITORIAL_BYLINE)} note covering ${escape(companyName)} (${escape(SYMBOL)}), newest first. Grounded in BSE/NSE primary-source filings.</description>
    <language>en-in</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
}
