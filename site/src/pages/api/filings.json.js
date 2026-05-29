// Read-only JSON list of recent Filing Notes at /api/filings.json.
// Advertised in /llms.txt for AI tools that prefer structured access over RSS.
// Newest first; full editorial structure per note so a note can be cited without
// scraping the HTML page.
import { listFilings, sourceLinks } from '../../lib/queries.mjs';
import { BRAND_NAME, BRAND_DESCRIPTION, EDITORIAL_BYLINE, EDITORIAL_BYLINE_SLUG } from '../../lib/brand.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';
  const filings = listFilings({ limit: 200 });

  const items = filings.map(f => {
    const src = sourceLinks(f);
    return {
      id: f.record_id,
      url: new URL(f.canonical_url, siteUrl).toString(),
      headline: f.headline,
      dek: f.dek,
      published: String(f.created_on).replace(' ', 'T') + '+05:30',
      symbol: f.symbol,
      company: f.company,
      sector: f.sector,
      category: f.canonical_category,
      score: f.score,
      tier: f.score >= 9 ? 'Alert' : f.score >= 7 ? 'Story' : 'Update',
      the_number: f.the_number?.value ? f.the_number : undefined,
      whats_new: f.whats_new,
      why_it_matters: f.why_it_matters,
      what_were_watching: f.what_were_watching,
      the_full_read: f.the_full_read,
      primary_sources: [src.bse_announcements, src.nse_announcements].filter(Boolean),
    };
  });

  const payload = {
    publication: BRAND_NAME,
    description: BRAND_DESCRIPTION,
    author: { name: EDITORIAL_BYLINE, url: new URL(`/authors/${EDITORIAL_BYLINE_SLUG}/`, siteUrl).toString() },
    license: 'Quote and cite with attribution to the canonical URL. AI training and retrieval-augmented use permitted with attribution.',
    count: items.length,
    items,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
