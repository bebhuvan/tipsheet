// RSS 2.0 feed at /feed.xml. Conventional channel + items.
// Aggregators (Pulse by Zerodha, IDE agents, Mint Genie, etc.) consume this format.
// Includes the 50 most-recent Stories + the latest two briefings.
// Shared rendering lives in ../lib/rss.mjs (also used by per-company feeds).

import { listFilings, listBriefings } from '../lib/queries.mjs';
import { BRAND_NAME, BRAND_TAGLINE, BRAND_DESCRIPTION } from '../lib/brand.mjs';
import { escapeXml, rfc822, filingFeedItem, rssDocument, rssResponse } from '../lib/rss.mjs';

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
      content: [b.dek, b.the_take].filter(Boolean).map(t => `<p>${escapeXml(t)}</p>`).join('\n') || null,
      category: 'Briefings',
    });
  }
  for (const f of filings) {
    items.push(filingFeedItem(f, siteUrl));
  }
  // Newest first
  items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  return rssResponse(rssDocument({
    title: `${BRAND_NAME} — ${BRAND_TAGLINE.replace(/\.$/, '')}`,
    link: siteUrl,
    selfHref: new URL('/feed.xml', siteUrl).toString(),
    description: BRAND_DESCRIPTION,
    items,
  }));
}
