// Read-only JSON for a single Filing Note at /api/filing/{slug}.json.
// Advertised in /llms.txt. The {id} matches the article slug used by [id].astro.
import { listAllForStaticPaths, recordIdFromSlug, getFiling, sourceLinks, tijoriCompanyUrl, getFundamentals } from '../../../lib/queries.mjs';
import { BRAND_NAME, EDITORIAL_BYLINE, EDITORIAL_BYLINE_SLUG } from '../../../lib/brand.mjs';

export async function getStaticPaths() {
  return listAllForStaticPaths().map(item => ({ params: { id: item.id } }));
}

export async function GET({ params, site }) {
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';
  const recordId = recordIdFromSlug(params.id);
  const filing = recordId ? getFiling(recordId) : null;

  if (!filing) {
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const src = sourceLinks(filing);
  const fund = getFundamentals(filing.symbol);

  const payload = {
    publication: BRAND_NAME,
    author: { name: EDITORIAL_BYLINE, url: new URL(`/authors/${EDITORIAL_BYLINE_SLUG}/`, siteUrl).toString() },
    url: new URL(filing.canonical_url, siteUrl).toString(),
    id: filing.record_id,
    headline: filing.headline,
    dek: filing.dek,
    published: String(filing.created_on).replace(' ', 'T') + '+05:30',
    symbol: filing.symbol,
    company: filing.company,
    sector: filing.sector,
    category: filing.canonical_category,
    score: filing.score,
    tier: filing.score >= 9 ? 'Alert' : filing.score >= 7 ? 'Story' : 'Update',
    the_number: filing.the_number?.value ? filing.the_number : null,
    whats_new: filing.whats_new,
    why_it_matters: filing.why_it_matters,
    what_were_watching: filing.what_were_watching,
    the_full_read: filing.the_full_read,
    editorial_tone: filing.editorial_tone,
    faqs: filing.faqs,
    fundamentals: fund ? {
      market_cap: fund.market_cap, pe: fund.pe, roe: fund.roe,
      debt_to_equity: fund.debt_to_equity, dividend_yield: fund.dividend_yield,
    } : null,
    primary_sources: [src.bse_announcements, src.nse_announcements].filter(Boolean),
    research: tijoriCompanyUrl(fund) || undefined,
    license: 'Quote and cite with attribution to the canonical URL above. AI training and retrieval-augmented use permitted with attribution.',
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
