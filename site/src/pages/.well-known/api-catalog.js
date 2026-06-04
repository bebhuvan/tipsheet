import { BRAND_NAME, BRAND_DESCRIPTION } from '../../lib/brand.mjs';

export async function GET({ site }) {
  const siteUrl = site?.toString() || 'https://tipsheet.markets/';
  const href = (path) => new URL(path, siteUrl).toString();
  const payload = {
    linkset: [
      {
        anchor: href('/'),
        describedby: [
          {
            href: href('/llms.txt'),
            type: 'text/plain',
            title: `${BRAND_NAME} guide for LLMs`,
          },
          {
            href: href('/openapi.json'),
            type: 'application/vnd.oai.openapi+json;version=3.1',
            title: `${BRAND_NAME} OpenAPI description`,
          },
        ],
        'service-desc': [
          {
            href: href('/openapi.json'),
            type: 'application/vnd.oai.openapi+json;version=3.1',
            title: `${BRAND_NAME} public JSON API`,
          },
        ],
        alternate: [
          {
            href: href('/feed.json'),
            type: 'application/feed+json',
            title: `${BRAND_NAME} JSON Feed`,
          },
          {
            href: href('/feed.xml'),
            type: 'application/rss+xml',
            title: `${BRAND_NAME} RSS Feed`,
          },
          {
            href: href('/sitemap.xml'),
            type: 'application/xml',
            title: `${BRAND_NAME} sitemap index`,
          },
        ],
        'agent-skills': [
          {
            href: href('/.well-known/agent-skills/index.json'),
            type: 'application/json',
            title: `${BRAND_NAME} Agent Skills index`,
          },
        ],
      },
    ],
    title: BRAND_NAME,
    description: BRAND_DESCRIPTION,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/linkset+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
