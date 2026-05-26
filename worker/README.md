# Cloudflare Workers deploy — skeleton

This directory holds the Cloudflare Workers configuration for production deployment. **Not deployed yet.** The local pipeline + static Astro build is the MVP. This is the deploy target once the editorial product is validated.

The separate `worker/telegram-notifier/` worker is still a thin article-push skeleton. The richer implementation currently lives in `pipeline/notify_telegram.mjs`, which sends briefing notifications and digest-first article updates with idempotent `notified_at` tracking. If Telegram moves fully to Workers, port that behavior rather than the older one-message-per-article skeleton.

## What goes here when we deploy

```
worker/
├── wrangler.toml              # workers + cron + D1 + queue config
├── poller/                    # cron-triggered worker (every 2 min)
│   └── index.ts               # ports pipeline/poller.mjs + run.mjs poll() logic
├── enricher/                  # queue consumer (concurrency 8)
│   └── index.ts               # ports pipeline/enricher.mjs
└── migrations/                # D1 SQL migrations (copies of pipeline/schema.sql)
```

## Architecture

```
Cron Trigger (every 2 min)
   ↓
Poller Worker
   - fetch TIJORI_FEED_URL
   - INSERT new filings into D1
   - send new record_ids → Queue
   ↓
Cloudflare Queue (FILINGS_TO_ENRICH)
   ↓
Enricher Worker (consumer, concurrency 8)
   - call DeepSeek
   - validate, retry with feedback on failure
   - INSERT into D1 filings_enriched
   ↓
Astro Worker (request-time SSR for /, /filings/[id] from cache)
   - reads D1
   - serves edge-cached pages
```

## Secrets

Set via Wrangler:

```bash
wrangler secret put TIJORI_FEED_URL
wrangler secret put DEEPSEEK_API_KEY
```

D1 binding name: `DB`. Queue binding: `FILINGS_QUEUE`. R2 bucket for OG images: `OG_IMAGES`.

## Migration path from local

1. Provision D1: `wrangler d1 create filings`
2. Apply schema: `wrangler d1 execute filings --file=../pipeline/schema.sql`
3. Bulk-load local SQLite into D1 (one-time dump + INSERT).
4. Provision queue: `wrangler queues create filings-to-enrich`
5. Set secrets (above).
6. Deploy: `wrangler deploy`
7. Verify cron trigger fires by checking logs: `wrangler tail`

## Why not deployed today

We haven't validated the editorial product yet. Running the local pipeline + static site for a few weeks lets us:
- Iterate on the prompt without redeploying workers
- See real reader behaviour on the dev preview before committing to infrastructure
- Adjust the design under real data load (now 1,000+ enriched filings and growing)

The code is structured so the swap is small: storage handle (SQLite → D1) and scheduler (loop.mjs → Cron Trigger). Logic modules (`poller.mjs`, `enricher.mjs`, `normalize.mjs`, `prompts/`) port verbatim.
