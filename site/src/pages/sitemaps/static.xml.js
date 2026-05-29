import { MARKET_CAP_TIERS, listFilings } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  // Latest filing timestamp drives lastmod for the news-driven index pages, so
  // Google recrawls them when there's fresh content. Static legal pages omit it.
  const newest = listFilings({ limit: 1 })[0]?.created_on;
  const latest = newest ? String(newest).replace(' ', 'T') + '+05:30' : undefined;
  const urls = [
    { loc: `${siteUrl}/`, priority: '1.0', changefreq: 'hourly', lastmod: latest },
    { loc: `${siteUrl}/filings/`, priority: '0.9', changefreq: 'hourly', lastmod: latest },
    { loc: `${siteUrl}/briefings/`, priority: '0.8', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/radar/`, priority: '0.8', changefreq: 'hourly', lastmod: latest },
    { loc: `${siteUrl}/markets/`, priority: '0.8', changefreq: 'hourly', lastmod: latest },
    { loc: `${siteUrl}/concalls/`, priority: '0.7', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/orders/`, priority: '0.7', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/alerts/`, priority: '0.7', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/regulation/`, priority: '0.7', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/economy/`, priority: '0.7', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/companies/`, priority: '0.6', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/sectors/`, priority: '0.6', changefreq: 'daily', lastmod: latest },
    { loc: `${siteUrl}/search/`, priority: '0.5', changefreq: 'weekly' },
    { loc: `${siteUrl}/about/`, priority: '0.4', changefreq: 'monthly' },
    { loc: `${siteUrl}/methodology/`, priority: '0.4', changefreq: 'monthly' },
    { loc: `${siteUrl}/editorial-standards/`, priority: '0.4', changefreq: 'monthly' },
    { loc: `${siteUrl}/ownership/`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${siteUrl}/corrections/`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${siteUrl}/privacy/`, priority: '0.2', changefreq: 'yearly' },
    { loc: `${siteUrl}/terms/`, priority: '0.2', changefreq: 'yearly' },
    { loc: `${siteUrl}/contact/`, priority: '0.2', changefreq: 'yearly' },
  ];
  for (const cat of ['earnings', 'concalls', 'order-wins', 'm-a', 'credit', 'regulatory']) {
    urls.push({ loc: `${siteUrl}/filings/category/${cat}/`, changefreq: 'daily', priority: '0.6' });
  }
  for (const tier of MARKET_CAP_TIERS) {
    urls.push({ loc: `${siteUrl}/filings/market-cap/${tier.slug}/`, changefreq: 'daily', priority: '0.6' });
  }
  return xmlResponse(urlset(urls));
}
