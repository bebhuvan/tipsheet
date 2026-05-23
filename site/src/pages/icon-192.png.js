// 192x192 PNG icon. Used by Android home-screen + manifest.
import { renderIconPng } from '../lib/icon.mjs';

export async function GET() {
  return new Response(renderIconPng(192), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
