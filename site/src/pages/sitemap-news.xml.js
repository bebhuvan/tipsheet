// Google News–specific sitemap. Only filings from the last 48 hours per Google's spec.
// https://developers.google.com/search/docs/specialty/news/news-sitemaps

import { listFilings, listSyntheses } from '../lib/queries.mjs';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value) {
  return String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

export async function GET({ site }) {
  const siteUrl = site?.toString().replace(/\/$/, '') || 'https://tipsheet.markets';
  // Alerts and Stories only (score ≥ 7): news surfaces judge the publication
  // by what we nominate here, so we put the strongest tier forward. Updates
  // remain in the regular sitemap and fully indexable.
  const all = listFilings({ limit: 1000, scoreMin: 7 });
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = all.filter(f => {
    const t = new Date(String(f.created_on).replace(' ', 'T')).valueOf();
    return !isNaN(t) && t >= cutoff;
  });

  // Results syntheses are flagship pieces — always nominated while fresh.
  const entries = recent.map(f => ({
    url: new URL(f.canonical_url, siteUrl).toString(),
    publication_date: String(f.created_on).replace(' ', 'T') + '+05:30',
    title: f.headline,
    keywords: [f.symbol, f.company, f.canonical_category, f.sector].filter(Boolean).join(', '),
  }));
  for (const p of listSyntheses({ limit: 100 })) {
    if (!p.generated_at || p.generated_at < cutoff) continue;
    entries.push({
      url: new URL(p.canonical_url, siteUrl).toString(),
      publication_date: new Date(p.generated_at).toISOString(),
      title: p.headline,
      keywords: [p.symbol, p.company, 'results', 'earnings call'].filter(Boolean).join(', '),
    });
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${entries.map(e => `  <url>
    <loc>${escapeXml(e.url)}</loc>
    <news:news>
      <news:publication>
        <news:name>Tipsheet</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${escapeXml(e.publication_date)}</news:publication_date>
      <news:title><![CDATA[${cdata(e.title)}]]></news:title>
      <news:keywords>${escapeXml(e.keywords)}</news:keywords>
    </news:news>
  </url>`).join('\n')}
</urlset>`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
