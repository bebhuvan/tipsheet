// Brand-fallback OG image. Used by the homepage and any index page without a specific article.
import { brandSvg, renderPng } from '../../lib/og.mjs';

export async function GET() {
  const png = renderPng(brandSvg());
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
