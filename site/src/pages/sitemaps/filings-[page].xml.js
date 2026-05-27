import { listFilings } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

const PAGE_SIZE = 45000;

export async function getStaticPaths() {
  const filings = listFilings({ limit: 50000 });
  const pages = Math.max(1, Math.ceil(filings.length / PAGE_SIZE));
  return Array.from({ length: pages }, (_, i) => ({ params: { page: String(i + 1) } }));
}

export async function GET({ params, site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const page = Math.max(1, Number(params.page) || 1);
  const filings = listFilings({ limit: 50000 }).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const urls = filings.map(f => ({
    loc: new URL(f.canonical_url, siteUrl).toString(),
    lastmod: String(f.created_on).replace(' ', 'T') + '+05:30',
    changefreq: 'monthly',
    priority: '0.7',
  }));
  return xmlResponse(urlset(urls));
}
