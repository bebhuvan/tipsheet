import { distinctSectorsWithFilings, sectorSlug } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const urls = distinctSectorsWithFilings().map(s => ({
    loc: new URL(`/sector/${sectorSlug(s.sector)}/`, siteUrl).toString(),
    changefreq: 'daily',
    priority: '0.5',
  }));
  return xmlResponse(urlset(urls));
}
