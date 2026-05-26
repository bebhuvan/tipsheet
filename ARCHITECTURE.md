# Filings — Architecture

An editorial publication that turns Indian exchange filings into "Filing Notes" — short, FT Lex–style editorial reads, grounded in source.

## Layout

```
News experiment/
├── ARCHITECTURE.md       ← this file
├── README.md             ← how to run
├── .env                  ← secrets (gitignored)
├── .env.example          ← template for new contributors
├── .gitignore
├── data/                 ← SQLite DB + generated assets (gitignored)
│   └── filings.db
├── pipeline/             ← ingest + enrich + store
│   ├── package.json
│   ├── schema.sql        ← D1-compatible
│   ├── prompts/          ← LLM prompts (system + user)
│   ├── poller.mjs        ← fetches the Tijori feed
│   ├── normalize.mjs     ← canonical category map
│   ├── db.mjs            ← SQLite handle + queries
│   ├── enricher.mjs      ← DeepSeek call + validation + feedback retry
│   ├── run.mjs           ← orchestrator (one-shot poll/enrich/both/stats)
│   └── loop.mjs          ← continuous scheduler for local dev
├── site/                 ← Astro app (the public site)
│   ├── package.json
│   ├── astro.config.mjs
│   ├── public/
│   │   ├── robots.txt
│   │   └── llms.txt
│   └── src/
│       ├── layouts/
│       ├── components/
│       ├── lib/          ← DB + query helpers
│       ├── pages/
│       └── styles/
└── worker/               ← Cloudflare Workers deploy config (skeleton)
    ├── wrangler.toml
    └── README.md
```

## Data flow

```
┌──────────────────────────────────────────────────────────────┐
│  Tijori feed (private URL — env var)                          │
└────────────────────────────┬─────────────────────────────────┘
                             │  every 2 min
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Poller                                                       │
│  - fetch + Zod validate                                       │
│  - normalize event_category → canonical bucket                │
│  - INSERT OR IGNORE into filings_raw (dedup by record_id)     │
└────────────────────────────┬─────────────────────────────────┘
                             │  new IDs only
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Enricher                                                     │
│  - DeepSeek native API (KV cache: shared system prompt)       │
│  - validate output (schema, banned phrases, number fidelity)  │
│  - feedback retry on failure (one extra turn, ≤2 calls/filing)│
│  - write to filings_enriched                                  │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  SQLite (local) / D1 (production)                             │
│  filings_raw · filings_enriched                               │
└────────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  Astro                                                        │
│  - Filing pages: prerendered (build-time, max edge cache)     │
│  - Home + Wire: SSR with 60s edge cache (fresh + fast)        │
│  - Zero JS on content pages; LightweightCharts lazy-loaded    │
└──────────────────────────────────────────────────────────────┘
```

## Secrets

| Secret | Where it lives | How it's set |
|---|---|---|
| `TIJORI_FEED_URL` | `.env` (local) · `wrangler secret` (prod) | hand-set |
| `DEEPSEEK_API_KEY` | `.env` (local) · `wrangler secret` (prod) | hand-set |
| `LLM_BASE_URL` | `.env` — defaults to `https://api.deepseek.com` | optional override |
| `LLM_MODEL` | `.env` — defaults to `deepseek-v4-flash` | optional override |

The Tijori URL **is itself a secret** (B2B endpoint, no auth, knowledge of the URL = access). Never commit it. Never hard-code it. Never expose it through the site.

## Scheduling

**Local dev**: `pipeline/loop.mjs` — long-running Node process; polls every 2 min, enriches new filings, sleeps, repeats. Idempotent (running twice is harmless).

**Production (Cloudflare Workers)**:
- Cron Trigger → Poller Worker (every 2 min during market hours, every 15 min off-hours)
- Poller pushes new record_ids to a **Cloudflare Queue**
- Enricher Worker consumes the queue (concurrency = 8, retries built-in)
- Enriched filings write to D1
- Astro Worker reads D1 for SSR

The local code paths and the Cloudflare paths share the same SQL schema and the same enricher/validator modules. The swap is at the storage and scheduling boundary, not the logic.

## Performance budget

| Page | Strategy | Target TTFB | Target LCP | JS shipped |
|---|---|---|---|---|
| Filing | Prerendered static HTML | ≤80ms (edge) | ≤500ms | 0 KB (chart loads on intent) |
| Homepage | SSR + 60s edge cache | ≤120ms | ≤700ms | 0 KB |
| Methodology / About | Static | ≤80ms | ≤400ms | 0 KB |

Decisions that make this possible:
- Astro renders to pure HTML by default (no React/Vue runtime in the browser)
- Fonts preloaded via `<link rel="preload">` (Newsreader + JetBrains Mono)
- TradingView Lightweight Charts loaded lazily only when a filing page renders a chart
- All static assets served from Cloudflare edge with `Cache-Control: public, max-age=31536000, immutable`
- D1 queries are single-roundtrip and indexed (see `schema.sql`)
- Theme toggle is a 12-line inline script — no framework hydration

## Scaling path

| Today | Tomorrow (Workers prod) | Eventually |
|---|---|---|
| Node `loop.mjs` | CF Cron Trigger | — |
| Inline enrich | CF Queues + 8x consumer workers | Auto-scale on backlog depth |
| SQLite | D1 (same schema) | Shard by year if `filings_raw` > 1M rows |
| Astro dev server | Astro on Workers + R2 for assets | + cache rules per route |
| Manual deploy | `wrangler deploy` (CI later) | GitHub Actions → preview deploys |

Migration cost local → production: tiny. The poll/enrich/validate logic is unchanged; only the storage handle and the scheduler swap.

## Scale plan — preventing slowdown as the archive grows

At 50-100 filings per day:
- 1 month → ~2,500 filings
- 6 months → ~15,000 filings
- 1 year → ~30,000 filings

The static-first model works up to ~5,000 filings. Beyond that we'd burn through build time and disk for pages no one's reading. The boundary moves cleanly:

**Tier 1 — recent (last 30 days, ~2,500 pages max):** stay prerendered as static HTML. Maximum cacheability, fastest possible TTFB for the pages readers actually click.

**Tier 2 — older filings:** switch to SSR-on-demand once we cross 5,000 total. `getStaticPaths` returns only the last 30 days; older slugs fall through to a server route that renders from D1 and sets `Cache-Control: public, max-age=31536000, immutable` (old filings don't change). First request: ~50-100ms render. Every subsequent request: edge cache, ~10ms.

**Tier 3 — eventually (50k+ filings):** D1 FTS5 search index, dedicated search Worker, year-sharded URLs (`/filings/2027/may/...`) for sitemap manageability.

The boundary lives in two places: `getStaticPaths()` in `site/src/pages/filings/[id].astro`, and the cache headers on the SSR fallback. Both are config changes, not refactors.

At 10,000 articles, the recommended operating model is hybrid:

- prerender the latest 30-60 days of article pages plus all high-value landing pages;
- keep `/filings/`, category pages, market-cap pages, company pages, sector pages, briefings and feeds static or edge-cached;
- render old long-tail article pages from D1 on first request and cache them for a year;
- split `/search-index.json` into monthly shards or move to D1 FTS if the gzipped index becomes too large;
- keep sitemaps complete, but use sitemap indexes if a single XML file approaches protocol limits.

## Archive + pagination + filters

`/filings/` — paginated archive, 25 per page, sorted by date desc.
`/filings/page/2/`, `/filings/page/3/` — Astro's `paginate()` generates these.
`/filings/category/[name]/` — pre-built per-category pages.
`/filings/market-cap/[tier]/` — pre-built market-cap pages for mega, large, mid, small and micro caps.
`/sector/[slug]/` — pre-built per-sector pages from the fundamentals taxonomy.

Market-cap tiers are a reader-relevance filter, not just metadata. Current coverage skews heavily toward micro and small caps, which is useful for discovery but noisy for readers who mainly care about liquid names. Static cap pages give those readers a clean route without requiring accounts or query-string SSR.

URL filters via arbitrary query params (`?score=8&cap=large`) would require SSR or client-side filtering. Defer until the archive needs compound filters.

## Search

Three options ranked by complexity:

1. **Client-side JSON index** (today): build a `/search-index.json` at build time containing `{id, slug, headline, symbol, company, sector, category, score, cap}` for every filing. Loaded on first search interaction (not on page load). Search via simple substring + a small ranking function. Works offline. Limit: gets sluggish past ~20k entries.

2. **Pre-built static search shards** (~5k+ filings): split the index by month, load only the shard the user is searching against. Or use a small client-side library like `FlexSearch` for proper ranked search.

3. **D1 FTS5 search endpoint** (~50k+ filings): full-text-search at the edge via Cloudflare Workers. Sub-50ms response, ranked, supports arbitrary queries. This is the long-term answer.

Today we ship (1). The endpoint code is small; we move to (3) when the index breaches ~3MB gzipped.

## Categorization (two layers)

**`canonical_category`** — pipeline-normalized to one of 7 buckets (Earnings / Concalls / Order Wins / M&A / Credit / Regulatory / Other). Hard-coded mapping table + LLM fallback in `pipeline/normalize.mjs`. This is the primary taxonomy that drives nav, briefs, archive filters.

**`sector`** — LLM-inferred per-filing (free text). Currently noisy: "IT Services" vs "Information Technology" vs "Software" coexist. Site-side normalization map (`site/src/lib/sectors.mjs`) collapses ~80 free-text sectors into ~15 canonical buckets for filtering. Pipeline-side normalization (deeper fix) comes when we add a `sector_canonical` column.

**Tags** (future): granular tags like "rights issue", "buyback", "USFDA", "QIP". Extracted by the LLM during enrichment. Used for search filters and topic pages. Deferred.

## LLM-citability + SEO

Baked into the Astro build:
- `NewsArticle` JSON-LD on every filing page (headline, dates, author, publisher, image, mainEntityOfPage)
- `Corporation` schema with ticker and BSE/NSE identifier on every filing
- `WebSite` + `SearchAction` JSON-LD on homepage
- `/llms.txt` describing the publication, sections, license
- `/robots.txt` permissive to citation bots (`GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`, `OAI-SearchBot`)
- `/feed.xml` (RSS) + `/feed.json` (JSON Feed)
- Google News–compatible sitemap at `/sitemap-news.xml`
- Public read-only JSON API at `/api/filings.json` and `/api/filing/[id].json`

## Telegram Distribution

Telegram should behave like a refresh digest, not a firehose. `pipeline/notify_telegram.mjs` now defaults to `TELEGRAM_DELIVERY_MODE=digest`, which consolidates newly published notes into one message per run. If LLM credentials are present it asks the model for an actionable digest; if not, it falls back to a deterministic grouped digest. `TELEGRAM_DELIVERY_MODE=individual` keeps the old one-message-per-article behavior for tests or exceptional high-urgency channels.

Briefings are notified first, then article digests. Both are idempotent via `notified_at`, so retries do not spam the channel.

## Briefing Retention

The `briefings` table uses `(type, date)` as its primary key. That means:

- re-running `briefing-open 2026-05-26` rewrites that one Open briefing;
- re-running `briefing-close 2026-05-26` rewrites that one Close briefing;
- older dates are retained and listed at `/briefings/`;
- generated prompt version and model are stored for audit.

The briefing prompt deliberately asks for 6-10 high-signal events rather than every article. It also tells the model to balance reader relevance by market cap: micro-cap events can lead when they are material, forensic, or broadly instructive, but a cluster of micro-cap filings should not bury broader large/mid-cap developments.

## What's intentionally NOT built yet

- Licensed market-data integration. `Makefile` still has a temporary `market-yf` target for briefing market strips and sparklines. Treat it as non-production scaffolding; replace it before relying on market data publicly.
- Email/WhatsApp alerts (post-launch feature)
- User accounts / watchlists (post-launch)
- Cloudflare deployment (config skeleton ready; live deploy is a separate decision)

These are intentionally deferred until the core editorial product is validated.

## Upstream requests (Tijori)

Two cheap additions on the Tijori side would materially improve our product:

1. **`source_url` field on every filing** — a direct link to the BSE/NSE filing PDF or announcement page. Today we derive a deep-link to the company's announcements index (one click from the specific filing); a direct URL would be exact and unambiguous, which both readers and LLM citation systems prefer. The information exists upstream (they're reading the actual filing to generate the rationale).
2. **A `sector` field, even free-text** — the feed has no sector classification. We currently let the enricher LLM infer sector from the company name, which works but is occasionally noisy. Even a free-text upstream sector would be authoritative.

Both are pure additive schema changes on their side. Worth asking.
