import { BRAND_NAME, BRAND_DESCRIPTION } from '../lib/brand.mjs';

export async function GET({ site }) {
  const siteUrl = (site?.toString() || 'https://tipsheet.markets/').replace(/\/$/, '');
  const spec = {
    openapi: '3.1.0',
    info: {
      title: `${BRAND_NAME} Public Content API`,
      version: '1.0.0',
      description: `${BRAND_DESCRIPTION} These read-only endpoints expose recent editorial notes for citation and retrieval.`,
    },
    servers: [{ url: siteUrl }],
    paths: {
      '/api/filings.json': {
        get: {
          operationId: 'listRecentFilings',
          summary: 'List recent Filing Notes',
          description: 'Returns recent Tipsheet Filing Notes with structured editorial fields and primary-source exchange links.',
          responses: {
            '200': {
              description: 'Recent Filing Notes',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/FilingsResponse' },
                },
              },
            },
          },
        },
      },
      '/api/filing/{slug}.json': {
        get: {
          operationId: 'getFilingBySlug',
          summary: 'Get one Filing Note by article slug',
          description: 'Returns one Filing Note as structured JSON. The slug is the final path segment from a canonical Tipsheet article URL.',
          parameters: [
            {
              name: 'slug',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Canonical article slug, including the numeric record id suffix.',
            },
          ],
          responses: {
            '200': {
              description: 'A Filing Note',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Filing' },
                },
              },
            },
            '404': {
              description: 'No Filing Note matched the slug',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        FilingsResponse: {
          type: 'object',
          required: ['publication', 'description', 'author', 'license', 'count', 'items'],
          properties: {
            publication: { type: 'string' },
            description: { type: 'string' },
            author: { $ref: '#/components/schemas/Author' },
            license: { type: 'string' },
            count: { type: 'integer' },
            items: {
              type: 'array',
              items: { $ref: '#/components/schemas/Filing' },
            },
          },
        },
        Filing: {
          type: 'object',
          required: ['id', 'url', 'headline', 'published'],
          properties: {
            publication: { type: 'string' },
            author: { $ref: '#/components/schemas/Author' },
            id: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            url: { type: 'string', format: 'uri' },
            headline: { type: 'string' },
            dek: { type: ['string', 'null'] },
            published: { type: 'string' },
            symbol: { type: ['string', 'null'] },
            company: { type: ['string', 'null'] },
            sector: { type: ['string', 'null'] },
            category: { type: ['string', 'null'] },
            score: { type: ['number', 'null'] },
            tier: { type: ['string', 'null'] },
            the_number: { type: ['object', 'null'] },
            whats_new: { type: 'array', items: {} },
            why_it_matters: { type: ['string', 'null'] },
            what_were_watching: { type: 'array', items: {} },
            the_full_read: { type: ['string', 'null'] },
            primary_sources: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
            },
          },
          additionalProperties: true,
        },
        Author: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            url: { type: 'string', format: 'uri' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  };

  return new Response(JSON.stringify(spec, null, 2), {
    headers: {
      'Content-Type': 'application/vnd.oai.openapi+json;version=3.1; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
