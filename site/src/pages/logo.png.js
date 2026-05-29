// Publisher logo at /logo.png. Referenced by the sitewide NewsMediaOrganization
// schema (Base.astro), every NewsArticle publisher.logo, and the JSON feed icon.
// Rendered build-time as a flat 1000×1000 PNG via resvg.
import { logoSvg, renderPng } from '../lib/og.mjs';

export async function GET() {
  const png = renderPng(logoSvg(), { width: 1000 });
  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
