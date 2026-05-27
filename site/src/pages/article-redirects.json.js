import { articleRedirectMap } from '../lib/queries.mjs';

export async function GET() {
  return new Response(JSON.stringify(articleRedirectMap()), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
