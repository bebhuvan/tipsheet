# Filings

An editorial publication that turns Indian exchange filings into Filing Notes — short FT Lex-style editorial reads, grounded in source.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## Project layout

```
.
├── pipeline/   ingest + LLM enrichment + storage (Node + SQLite)
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
```

The pipeline writes to `../data/filings.db`. The site reads from the same DB.

## Running the site

```bash
cd site

# dev server (hot reload, reads DB on every request)
npm run dev

# production build (491 static HTML pages — homepage + all filing pages)
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
7. **Store** — written to `filings_enriched`. Site rebuilds (or, in prod, re-renders via cache revalidation) and the Filing Note is live.

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
- `site/` → Astro on Workers (with `@astrojs/cloudflare` adapter)

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
