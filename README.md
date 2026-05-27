# Tipsheet

An editorial publication that turns Indian exchange filings into short, source-grounded Tipsheet notes and twice-daily market briefings.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## Project layout

```
.
├── pipeline/   ingest + LLM enrichment + briefings + Telegram distribution
├── site/       Astro frontend (static site for MVP, hybrid SSR-ready)
├── data/       SQLite DB (gitignored)
├── worker/     Cloudflare Workers config (skeleton — future deploy target)
├── .env        secrets (gitignored; copy .env.example)
└── ARCHITECTURE.md
```

## Setup

```bash
# 1. copy env template and fill in secrets
cp .env.example .env
$EDITOR .env     # set DEEPSEEK_API_KEY, TIJORI_FEED_URL

# 2. install pipeline deps
cd pipeline && npm install && cd ..

# 3. install site deps
cd site && npm install && cd ..
```

## Running the pipeline

```bash
cd pipeline

# one-shot poll (fetch feed, dedup, insert new filings)
node --env-file=../.env run.mjs poll

# enrich up to 50 pending filings via DeepSeek
node --env-file=../.env run.mjs enrich 50

# poll + enrich in one cycle
node --env-file=../.env run.mjs both

# continuous loop (poll every POLL_INTERVAL_SEC, sleep, repeat)
node --env-file=../.env loop.mjs

# DB stats
node --env-file=../.env run.mjs stats

# generate briefings
node --env-file=../.env run.mjs briefing-open
node --env-file=../.env run.mjs briefing-close

# send Telegram digest/alerts
node --env-file=../.env notify_telegram.mjs
```

The pipeline writes to `../data/filings.db`. The site reads from the same DB.

## Running the site

```bash
cd site

# dev server (hot reload, reads DB on every request)
npm run dev

# production build (static pages for filings, cap filters, companies, sectors, briefings)
npm run build

# preview the production build locally
npm run preview
```

Dev server runs at `http://localhost:4321` by default.

## Editorial pipeline (what happens to a filing)

1. **Poll** — `pipeline/poller.mjs` fetches the Tijori B2B feed every 2 minutes (URL is a secret — see `.env`).
2. **Normalize** — `pipeline/normalize.mjs` maps the noisy upstream `event_category` (~25 values) into 6 canonical buckets (Earnings, Concalls, Order Wins, M&A, Credit, Regulatory).
3. **Dedup** — `pipeline/db.mjs` inserts only filings whose `record_id` we haven't seen.
4. **Enrich** — `pipeline/enricher.mjs` sends the rationale to DeepSeek with a long stable system prompt (KV-cached, 50× cheaper after first call). Output is a Filing Note JSON.
5. **Validate** — schema check + banned-phrase scan + number fidelity audit.
6. **Feedback retry** — on validation failure, the failing output goes back to the model with explicit "you used these banned phrases — try again" feedback. Pushes pass rate from 73% to ~98%.
7. **Store** — written to `filings_enriched`. Site rebuilds and the note is live.
8. **Distribute** — `notify_telegram.mjs` sends a digest-first Telegram update. Individual article alerts are still available with `TELEGRAM_DELIVERY_MODE=individual`.

## Briefings

The Open and The Close live in the `briefings` table with primary key `(type, date)`.

- Re-running `briefing-open 2026-05-26` rewrites that specific Open briefing.
- Older dates are retained and listed at `/briefings/`.
- Briefing pages link back to the archive as “Older briefings”.
- Prompt version is recorded in the row so future prompt changes can be audited.

The briefing prompt asks for 10-14 high-signal events on busy days, not a complete wire dump. It explicitly tells the model not to let clusters of small and micro-cap filings crowd out large/mid-cap developments unless the smaller filing is genuinely consequential.

The Open and The Close now use a wider input set and are expected to carry more of the day's shape: 10-14 events on busy days, a sector/market-cap map, recent Concall Note read-throughs, management-consistency flags, and macro calendar items. The rendered briefing also groups selected companies by cap tier and sector so readers can see whether the tape was large-cap led, mid-cap led, or mostly small/micro-cap noise.

## Concall Notes

Concall Notes are structured around themes, not transcript recaps. The enricher extracts:

- what changed;
- business themes such as demand, margins, capex, order book, pricing, working capital and debt;
- guidance to watch;
- risk flags;
- key quotes;
- the management-consistency flag when management changed its story.

The article page renders these as theme cards plus guidance/risk blocks before the editorial brief.

## Discovery And Filters

The archive supports category filters and market-cap filters:

- `/filings/market-cap/mega-cap/`
- `/filings/market-cap/large-cap/`
- `/filings/market-cap/mid-cap/`
- `/filings/market-cap/small-cap/`
- `/filings/market-cap/micro-cap/`

Market-cap tiers are derived from `fundamentals.market_cap` in crore:

| Tier | Market cap |
|---|---:|
| Mega cap | `>= ₹100,000 cr` |
| Large cap | `₹20,000-100,000 cr` |
| Mid cap | `₹5,000-20,000 cr` |
| Small cap | `₹1,000-5,000 cr` |
| Micro cap | `< ₹1,000 cr` |

`/search-index.json` includes cap labels in the searchable text and is no longer capped at the newest 1,000 notes.

## Freshness And Health

Pipeline runs update `source_health` in the SQLite/D1 schema. The site publishes a lightweight health document at `/api/health.json` with latest source status, article counts, and newest filing timestamps.

The Cloudflare Worker also has a scheduled watchdog (`site/wrangler.toml`) that can dispatch `pipeline.yml` if the latest successful Fast News run is stale. Configure `GITHUB_REPOSITORY` and `GITHUB_ACTIONS_TOKEN` as Cloudflare secrets before relying on it.

Article slugs are now immutable once first written to `filings_enriched.slug`. Future headline edits should not change published URLs.

## Scaling To 10,000 Articles

At 10,000 notes, keep the current static-first model for recent article pages, high-value archive/filter pages, company and sector landing pages, feeds, sitemaps, and briefing pages.

The pressure points are not SQLite/D1 itself; they are build time, search payload size, and archive pagination. The practical path is:

1. Keep static article pages while builds stay acceptable.
2. Cap prerendered article pages to the most recent 30-60 days once build time becomes painful.
3. Serve older articles via Cloudflare Workers + D1 with long edge cache.
4. Split search into monthly shards or move to D1 FTS once the gzipped index becomes too large.
5. Keep market-cap/category/sector pages as discovery entry points, but paginate or SSR deep pages.

Sitemaps are already split through a sitemap index at `/sitemap.xml`, with child sitemaps under `/sitemaps/`, so URL growth does not push a single XML document past protocol limits.

## Editorial rules (encoded in the system prompt)

- Subject = the company, not the document.
- Verbs = action (`flags`, `lands`, `slips`, `locks in`), not procedure (`announces`, `discloses`).
- Every concrete claim must trace to the source rationale.
- No "investors will…" / "the market expects…" unless source explicitly attributes.
- No "leverage", "transformative", "navigate", "robust", "going forward".
- Write thin when the filing is thin. Padding is the worst sin.

See `pipeline/prompts/system.txt` for the full spec.

## Production deploy (Cloudflare Workers — future)

The whole stack ports to Cloudflare:
- `pipeline/poller.mjs` → Worker on a Cron Trigger
- `pipeline/enricher.mjs` → Worker consuming a Queue
- `data/filings.db` → D1 (same SQL schema)
- `site/` → Astro on Workers or static assets behind the existing Worker wrapper

Wrangler config lives in `worker/` once we deploy. The local pipeline keeps working; we run both in parallel during the transition.

## Costs

| Component | Cost |
|---|---|
| LLM enrichment | ~$0.0014 per filing (DeepSeek v4-flash with cache) |
| 50 filings/day | ~$2/month |
| Cloudflare Workers free tier | covers everything at our volume |
| Domain + Cloudflare DNS | ~$10/year |

Total operating cost at projected volume: under $5/month.

## Secrets handling

- `.env` is gitignored. Never commit.
- `.env.example` documents required vars without values.
- `TIJORI_FEED_URL` is itself a secret — knowledge of the URL = access. Never log, never expose to the site.
- Production secrets via `wrangler secret put`.

## License

Code: MIT. Editorial content: © Filings. See `site/public/llms.txt` for citation and AI-training policy.
