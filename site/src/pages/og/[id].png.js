// Per-article OG image. Static-mode: one PNG generated at build per filing.
import { listAllForStaticPaths, getFiling, recordIdFromSlug, tierFor } from '../../lib/queries.mjs';
import { ogSvg, renderPng } from '../../lib/og.mjs';

export async function getStaticPaths() {
  return listAllForStaticPaths().map(item => ({ params: { id: item.id } }));
}

export async function GET({ params }) {
  const recordId = recordIdFromSlug(params.id);
  const f = recordId ? getFiling(recordId) : null;
  if (!f) return new Response('Not found', { status: 404 });

  const svg = ogSvg({
    headline: f.headline,
    tier: tierFor(f.score),
    sector: f.sector || '',
    ticker: f.symbol || '',
    edition: '',
  });
  const png = renderPng(svg);
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
