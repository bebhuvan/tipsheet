// JSON Feed 1.1 at /feed.json. https://jsonfeed.org/version/1.1
// LLM-friendly structured access — easier to parse than RSS for AI tools that ingest feeds.

import { listFilings, listBriefings } from '../lib/queries.mjs';
import { BRAND_NAME, BRAND_TAGLINE, BRAND_DESCRIPTION, EDITORIAL_BYLINE, EDITORIAL_BYLINE_SLUG } from '../lib/brand.mjs';

function briefingPublishedIso(b) {
  return `${b.date}T${b.type === 'close' ? '16:00:00' : '08:00:00'}+05:30`;
}

export async function GET({ site }) {
  const filings = listFilings({ limit: 50 });
  const briefings = listBriefings(2);
  const siteUrl = site?.toString() || 'https://filings.in/';

  const items = [];
  for (const b of briefings) {
    items.push({
      id: new URL(b.canonical_url, siteUrl).toString(),
      url: new URL(b.canonical_url, siteUrl).toString(),
      title: `${b.label}: ${b.headline}`,
      summary: b.dek,
      content_text: [b.dek, b.the_take].filter(Boolean).join('\n\n'),
      date_published: new Date(briefingPublishedIso(b)).toISOString(),
      tags: ['Briefings', b.type],
      authors: [{ name: EDITORIAL_BYLINE, url: new URL(`/authors/${EDITORIAL_BYLINE_SLUG}/`, siteUrl).toString() }],
    });
  }
  for (const f of filings) {
    items.push({
      id: new URL(f.canonical_url, siteUrl).toString(),
      url: new URL(f.canonical_url, siteUrl).toString(),
      title: f.headline,
      summary: f.dek,
      content_text: [f.dek, f.why_it_matters].filter(Boolean).join('\n\n'),
      date_published: new Date(String(f.created_on).replace(' ', 'T') + '+05:30').toISOString(),
      tags: [f.canonical_category, f.sector, f.symbol].filter(Boolean),
      authors: [{ name: EDITORIAL_BYLINE, url: new URL(`/authors/${EDITORIAL_BYLINE_SLUG}/`, siteUrl).toString() }],
      _filings: {
        symbol: f.symbol,
        score: f.score,
        category: f.canonical_category,
        the_number: f.the_number,
      },
    });
  }
  items.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: `${BRAND_NAME} — ${BRAND_TAGLINE.replace(/\.$/, '')}`,
    home_page_url: siteUrl,
    feed_url: new URL('/feed.json', siteUrl).toString(),
    description: BRAND_DESCRIPTION,
    language: 'en-IN',
    icon: new URL('/logo.png', siteUrl).toString(),
    favicon: new URL('/favicon.ico', siteUrl).toString(),
    authors: [{ name: 'Tipsheet Editorial', url: new URL('/authors/filings-editorial/', siteUrl).toString() }],
    items,
  };

  return new Response(JSON.stringify(feed, null, 2), { headers: { 'Content-Type': 'application/feed+json; charset=utf-8' } });
}
