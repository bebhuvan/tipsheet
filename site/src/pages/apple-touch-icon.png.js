// Apple touch icon, 180x180. Used by iOS home-screen bookmarks.
import { renderIconPng } from '../lib/icon.mjs';

export async function GET() {
  return new Response(renderIconPng(180), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
