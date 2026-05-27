import { getFreshnessSummary } from '../../lib/queries.mjs';

export async function GET() {
  return new Response(JSON.stringify(getFreshnessSummary(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
