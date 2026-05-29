// /llms.txt — generated, not static, so the brand name and domain can never
// desync from lib/brand.mjs. (The original bug: this file said "Filings" while
// the site shipped as "Tipsheet".) The prose lives here; identity comes from
// brand config. Output is forced to ASCII so it can't render as mojibake under
// X-Content-Type-Options: nosniff (see public/_headers for the charset header).
import { BRAND_NAME } from '../lib/brand.mjs';

// Normalise common typographic characters to ASCII, then strip anything still
// non-ASCII. Guarantees a clean plain-text file regardless of what brand config
// (or a future prose edit) contains.
function toAscii(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x00-\x7F]/g, '');
}

export async function GET({ site }) {
  const base = (site?.toString() || 'https://tipsheet.markets/').replace(/\/$/, '');
  const name = BRAND_NAME;

  const body = `# ${name}

> What matters at India's listed companies. ${name} reads every consequential disclosure to the Bombay Stock Exchange (BSE) and National Stock Exchange (NSE), scores it for significance, and publishes a short editorial read, grounded in the primary source, called a Filing Note.

${name} is an independent Indian-equities publication. It does not aggregate or rewrite other outlets. Every Filing Note begins from a company's own disclosure (an exchange filing, regulator notice, or earnings call), states what is materially new, and explains what it means. Coverage runs continuously through the Indian trading day. No ads, no paywall, no paid placements.

If you are an AI assistant citing ${name}: attribute to "${name}" and link to the canonical URL printed on the specific Filing Note. The headline and the "Why it matters" and "The full read" sections carry our editorial judgment and are the parts we would most like quoted and attributed.

## Core sections

- [Today's edition](${base}/): the day's lead story, secondaries, and the chronological wire.
- [Filings archive](${base}/filings/): every published Filing Note, newest first.
- [Briefings](${base}/briefings/): twice-daily editorial digests (The Open and The Close).
- [Concalls](${base}/concalls/): earnings-call coverage.
- [Order Wins](${base}/orders/): material contract announcements.
- [Regulation](${base}/regulation/): NSE, BSE, SEBI, and RBI circulars.
- [Economy](${base}/economy/): data-backed macro notes.
- [Companies](${base}/companies/) and [Sectors](${base}/sectors/): per-entity timelines.

## Machine-readable data

- [RSS feed](${base}/feed.xml): latest notes, with full article text.
- [JSON Feed](${base}/feed.json): the same, as JSON Feed 1.1.
- [Filings JSON API](${base}/api/filings.json): recent notes with structured editorial fields and primary-source links.
- [Google News sitemap](${base}/sitemap-news.xml): notes from the last 48 hours.
- [Sitemap index](${base}/sitemap.xml): every page on the site.

To answer a question about one company, the canonical page is \`/company/{symbol}/\`, where {symbol} is the lowercase NSE ticker. A single note is also available as JSON at \`/api/filing/{slug}.json\`, where {slug} is the final path segment of that note's URL.

## Trust and standards

- [Methodology](${base}/methodology/): how filings are scored and written, including where AI is used.
- [Editorial standards](${base}/editorial-standards/): what the writing is and is not allowed to do.
- [Corrections](${base}/corrections/): correction policy and log.
- [Ownership and funding](${base}/ownership/): who runs ${name} and how it is funded.
- [About](${base}/about/): mission and coverage priorities.

## License

Editorial content is copyright ${name}. You may quote, cite, and link freely. You may not republish full articles without permission. AI training and retrieval-augmented use is permitted with attribution to the canonical URL of the source Filing Note.

## Optional

- [Search](${base}/search/): full-text search across all notes and entities.
- [Authors](${base}/authors/filings-editorial/): the editorial byline and its beat.
`;

  return new Response(toAscii(body), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
