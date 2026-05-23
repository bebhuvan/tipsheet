// 512x512 PNG icon. Used by Android home-screen, PWA, Google Search Console.
import { renderIconPng } from '../lib/icon.mjs';

export async function GET() {
  return new Response(renderIconPng(512), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
