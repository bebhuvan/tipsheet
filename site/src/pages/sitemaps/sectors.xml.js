import { distinctSectorsWithFilings, sectorSlug, filingsForSector } from '../../lib/queries.mjs';
import { urlset, xmlResponse } from '../../lib/sitemap.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  const urls = distinctSectorsWithFilings().map(s => {
    // Newest filing in the sector → lastmod. One cheap query per sector (sectors
    // number in the dozens, so this stays negligible at build time).
    const newest = filingsForSector(s.sector, 1)[0]?.created_on;
    return {
      loc: new URL(`/sector/${sectorSlug(s.sector)}/`, siteUrl).toString(),
      lastmod: newest ? String(newest).replace(' ', 'T') + '+05:30' : undefined,
      changefreq: 'daily',
      priority: '0.5',
    };
  });
  return xmlResponse(urlset(urls));
}
