import { getStore } from '../../lib/content-store.mjs';

export async function GET({ locals } = {}) {
  // Reads through the async ContentStore seam (Phase 2). At build time this is
  // the SQLite store; under SSR it would be D1 via locals.runtime.env.
  const store = await getStore(locals?.runtime?.env);
  const summary = await store.getFreshnessSummary();
  return new Response(JSON.stringify(summary, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
