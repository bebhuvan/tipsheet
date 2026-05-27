import { MARKET_CAP_TIERS } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const urls = [
    { loc: `${siteUrl}/`, priority: '1.0', changefreq: 'hourly' },
    { loc: `${siteUrl}/filings/`, priority: '0.9', changefreq: 'hourly' },
    { loc: `${siteUrl}/briefings/`, priority: '0.8', changefreq: 'daily' },
    { loc: `${siteUrl}/radar/`, priority: '0.8', changefreq: 'hourly' },
    { loc: `${siteUrl}/markets/`, priority: '0.8', changefreq: 'hourly' },
    { loc: `${siteUrl}/concalls/`, priority: '0.7', changefreq: 'daily' },
    { loc: `${siteUrl}/orders/`, priority: '0.7', changefreq: 'daily' },
    { loc: `${siteUrl}/alerts/`, priority: '0.7', changefreq: 'daily' },
    { loc: `${siteUrl}/regulation/`, priority: '0.7', changefreq: 'daily' },
    { loc: `${siteUrl}/economy/`, priority: '0.7', changefreq: 'daily' },
    { loc: `${siteUrl}/companies/`, priority: '0.6', changefreq: 'daily' },
    { loc: `${siteUrl}/sectors/`, priority: '0.6', changefreq: 'daily' },
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
