import { listFilings, listAllCompanies, listAllSectors, sectorSlug } from '../lib/queries.mjs';

// One flat index, fetched once by /search/ and filtered client-side.
// Kept compact: short field names, only what's needed to display a result row.
// `q` is the lowercased haystack; `s` is a short label for the result type.
export async function GET() {
  const filings = listFilings({ limit: 50000 });
  const companies = listAllCompanies();
  const sectors = listAllSectors();

  const entries = [];

  for (const f of filings) {
    // `d` (dek) is part of the searchable haystack `q` but not stored separately
    // — it isn't shown in the result rows, so keeping it twice wastes bytes.
    // `ti` (tier name) is derivable from `sc` client-side, also dropped.
    entries.push({
      s: 'filing',
      u: f.canonical_url,
      h: f.headline,
      sym: f.symbol,
      sec: f.sector || '',
      cap: f.market_cap_label || '',
      cat: f.canonical_category || '',
      sc: f.score,
      t: f.created_on || '',
      q: [f.headline, f.dek, f.symbol, f.company, f.sector, f.canonical_category, f.market_cap_label]
         .filter(Boolean).join(' ').toLowerCase(),
    });
  }

  for (const c of companies) {
    entries.push({
      s: 'company',
      u: `/company/${String(c.symbol).toLowerCase()}/`,
      h: c.company || c.symbol,
      sym: c.symbol,
      sec: c.sector || '',
      n: c.article_count || 0,
      q: [c.company, c.symbol, c.sector].filter(Boolean).join(' ').toLowerCase(),
    });
  }

  for (const sec of sectors) {
    entries.push({
      s: 'sector',
      u: `/sector/${sectorSlug(sec.sector)}/`,
      h: sec.sector,
      n: sec.article_count || 0,
      q: String(sec.sector).toLowerCase(),
    });
  }

  return new Response(JSON.stringify(entries), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
