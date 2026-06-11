// Per-company RSS 2.0 feed at /company/[symbol]/feed.xml.
// One feed per company covered. Useful for: journalists tracking a single ticker,
// aggregators (Pulse by Zerodha, Mint Genie etc.) republishing per-company news,
// IDE / LLM agents pulling structured company history.
// Shared rendering lives in ../../../lib/rss.mjs (also used by /feed.xml).

import { distinctSymbolsWithFilings, filingsForCompany } from '../../../lib/queries.mjs';
import { BRAND_NAME, EDITORIAL_BYLINE } from '../../../lib/brand.mjs';
import { filingFeedItem, rssDocument, rssResponse } from '../../../lib/rss.mjs';

export async function getStaticPaths() {
  return distinctSymbolsWithFilings().map(s => ({ params: { symbol: String(s.symbol).toLowerCase() } }));
}

export async function GET({ params, site }) {
  const { symbol } = params;
  const SYMBOL = String(symbol).toUpperCase();
  const filings = filingsForCompany(SYMBOL, 50);
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';
  const companyName = filings[0]?.company || SYMBOL;

  return rssResponse(rssDocument({
    title: `${companyName} (${SYMBOL}) — ${BRAND_NAME}`,
    link: new URL(`/company/${symbol}/`, siteUrl).toString(),
    selfHref: new URL(`/company/${symbol}/feed.xml`, siteUrl).toString(),
    description: `Every ${EDITORIAL_BYLINE} note covering ${companyName} (${SYMBOL}), newest first. Grounded in BSE/NSE primary-source filings.`,
    items: filings.map(f => filingFeedItem(f, siteUrl)),
  }));
}
