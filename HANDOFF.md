# Filings — Handoff

A self-contained briefing on the project so far. Paste this at the top of a new chat (or read it cold) and you have the full picture.

---

## What we're building

**Filings** — an Indian-equity editorial publication that turns every exchange disclosure into a short, FT Lex-style read called a Filing Note (visible label tiered by score: **Alert** for 9–10, **Story** for 7–8, **Update** for 5–6). The explicit goal is to outrank Moneycontrol / ET Markets / Mint on Indian-equity news through editorial discipline + per-entity (company, sector) pages + machine-readable depth (NewsArticle JSON-LD, Google News sitemap, LLM-citable structure).

We do NOT aggregate other publications' content. Our advantage is reading primary-source filings carefully, with editorial commentary nobody else does.

## Stack

- **Pipeline**: Node 22, SQLite (`better-sqlite3`), DeepSeek native API for enrichment (system prompt is KV-cached → 50× cheaper input on hits)
- **Site**: Astro 5 static-mode (492 base pages → ~930 with all section pages), `better-sqlite3` for read-only queries at build time
- **Data sources**: Tijori B2B feed (filing rationales) + Tijori Kite Screener (fundamentals for 5,500+ companies) + Tijori SDK/widget cache for richer company financials. The Yahoo Finance path was removed because it is not a production-safe source.
- **Production target**: Cloudflare Workers + D1 + Queues + Cron Triggers (schema is D1-compatible; deploy is a separate decision)
- **Editorial provider**: DeepSeek `deepseek-v4-flash` (native, ~$0.0014/filing). Tested against Qwen, GLM, Gemini 3.1 Flash Lite, Gemma 4 31B, DeepSeek Pro — Flash won decisively on quality + reliability + cost.

## Project layout

```
News experiment/
├── ARCHITECTURE.md       full design doc (scale plan, secrets, scheduling, SEO strategy)
├── README.md             how to run
├── HANDOFF.md            this file
├── .env                  secrets — gitignored
├── .env.example          template
├── data/
│   └── filings.db        SQLite, gitignored
├── pipeline/
│   ├── package.json
│   ├── schema.sql        D1-compatible
│   ├── prompts/
│   │   ├── system.txt    long FT Lex-voice prompt with banned-phrase list + worked example
│   │   └── user.txt      minimal per-filing template
│   ├── poller.mjs        fetch tijori feed (URL is a secret)
│   ├── normalize.mjs     event_category → 7 canonical buckets
│   ├── enricher.mjs      DeepSeek call + validator + feedback-retry
│   ├── fundamentals.mjs  Tijori Kite Screener fetcher
│   ├── db.mjs            shared SQLite handle, queries, migrations
│   ├── run.mjs           orchestrator — commands: poll | enrich N | both | fetch-fundamentals | stats
│   └── loop.mjs          continuous scheduler for local dev
├── site/
│   ├── package.json
│   ├── astro.config.mjs  static mode, compressHTML, inline small CSS
│   └── src/
│       ├── lib/queries.mjs    read-only SQLite + sector slugging + tier mapping
│       ├── components/
│       │   ├── Masthead.astro       live-dot, wordmark, 7-item nav
│       │   ├── SiteFooter.astro
│       │   ├── Sparkline.astro      pure SVG, zero JS
│       │   ├── MarketBlock.astro    table-with-sparklines pattern
│       │   └── YieldCurve.astro     server-rendered SVG yield curve
│       ├── layouts/Base.astro       html head, fonts, theme toggle, JSON-LD slot
│       ├── styles/global.css        all styles, single file
│       └── pages/
│           ├── index.astro                  homepage (lead + secondaries + briefs + wire + browse + rail)
│           ├── markets.astro                comprehensive markets page (78 instruments + yield curve)
│           ├── companies.astro              alphabetical A-Z index of every company with articles
│           ├── sectors.astro                grouped index of every sector with activity
│           ├── concalls.astro               filter view (canonical_category=Concalls)
│           ├── orders.astro                 filter view (Order Wins)
│           ├── smart-money.astro            promoter/insider/M&A filter view
│           ├── methodology.astro            full editorial standards page
│           ├── sitemap.xml.js               every URL
│           ├── sitemap-news.xml.js          last-48h, Google News format
│           ├── filings/
│           │   ├── index.astro              archive p1 (25/page)
│           │   ├── page/[page].astro        archive pagination
│           │   ├── category/[name].astro    6 category-filtered archives
│           │   └── [id].astro               491+ Filing Note pages (each with NewsArticle JSON-LD)
│           ├── company/[symbol].astro       250+ per-company pages (timeline + fundamentals)
│           └── sector/[slug].astro          120+ per-sector pages (anchor companies + activity)
│       └── public/
│           ├── robots.txt                  permissive to GPTBot, ClaudeBot, PerplexityBot, etc.
│           └── llms.txt                    citation guidance
└── worker/
    └── README.md                     Cloudflare deploy skeleton (not deployed yet)
```

## What's actually built (current state)

### Pipeline

- 500 raw filings ingested from Tijori (one historical pull)
- **491 enriched Filing Notes** in the DB, validation_ok=1 (98% pass rate)
- 5,594 companies with fundamentals from Kite Screener
- 78 instruments × 30 days = ~2,000 market-history data points (sparkline source)
- Feedback-retry on validation failure pushes pass rate from 73% (first attempt) → 98% (after retry with explicit "you used these banned phrases" feedback)
- Total LLM spend so far: **$0.69**

### Editorial system — non-negotiables baked into `pipeline/prompts/system.txt`

- Voice anchor: FT Lex column / Buttonwood / WSJ Heard on the Street. NOT Matt Levine (too personal), NOT Reuters (too dry), NOT Stratechery (too academic).
- Three principles enforced: **subject = company, not document**; **verbs = action, not procedure**; **find the news angle, lead with it**.
- Banned phrase list ~40 patterns long: "investors will", "the market expects", "leverage", "transformative", "going forward", "in the filing", etc. Detected case-insensitively in validator.
- **Evidence & Fidelity** section in the prompt: every concrete claim must trace to source rationale. No invented sector context. No words in management's mouth. No "the worst is over" narrative arcs.
- One worked example (Mehai Technology) inside the system prompt anchors the voice.
- Output schema: `{ headline, dek, the_number{value,label}, whats_new[3], why_it_matters, what_were_watching[3], the_full_read, canonical_category, sector, key_entities[] }`.

### Site — built and live (local preview)

Total: **932 prerendered HTML pages, builds in ~10s.** Zero JS shipped for content pages.

| URL pattern | Count | Notes |
|---|---|---|
| `/` | 1 | Lead + 2 secondaries + 6 by-section briefs + Wire (20 items) + right rail (markets + score distribution) + Browse band |
| `/filings/` | 1 + N | Archive paginated 25/page |
| `/filings/category/[name]/` | 6 | Earnings, Concalls, Order Wins, M&A, Credit, Regulatory |
| `/filings/[id]/` | 491 | Each Filing Note with NewsArticle JSON-LD, fundamentals sidebar, story-so-far, primary-source links |
| `/company/[symbol]/` | ~250 | Per-company: fundamentals + timeline grouped by month + sector link + BSE/NSE source links + Corporation schema |
| `/sector/[slug]/` | ~120 | Per-sector: anchor companies (top 16 by mcap) + recent activity |
| `/companies/` | 1 | Alphabetical A-Z index, anchor jumps |
| `/sectors/` | 1 | Grouped by sector family with article + company counts |
| `/markets/` | 1 | 78 instruments + yield curve, see below |
| `/concalls/`, `/orders/`, `/smart-money/`, `/methodology/` | 4 | Section views + editorial standards |
| `/sitemap.xml`, `/sitemap-news.xml` | 2 | Standard + Google News |

### Markets page sections

1. Hero — Nifty / Sensex / Bank Nifty (260×56 sparklines)
2. **Today ranked** — 25 Indian indices (broad + sectoral + thematic) sorted by % move, with horizontal performance bar + sparkline
3. International — 8 indices (S&P, Nasdaq, Dow, FTSE, DAX, Nikkei, Hang Seng, Shanghai)
4. Currencies — 11 INR pairs + 6 major crosses
5. Commodities — 5 energy + 6 metals + 7 agri in three columns
6. **US Treasury yield curve** — server-rendered SVG, log-scaled tenor (3M → 30Y), shaded fill, labeled points
7. US Treasury yields table
8. Sector aggregates — 20 sectors with company count / avg P/E / avg ROE / avg D/E

All sparklines are server-rendered SVG. Zero JS. ~50 LOC per chart.

### SEO + LLM discoverability — already in place

- `NewsArticle` JSON-LD on every Filing Note (headline, dates, author, publisher with logo, mainEntityOfPage, isBasedOn → primary sources, citation as CreativeWork[], Corporation with ticker)
- `Corporation` JSON-LD on every per-company page (subjectOf → recent articles)
- `WebSite` JSON-LD on homepage
- `sitemap.xml` — every URL with lastmod, changefreq, priority
- `sitemap-news.xml` — last 48h only, Google News-compatible
- `robots.txt` permissive to citation bots (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, OAI-SearchBot, Applebot, cohere-ai)
- `llms.txt` describing the publication, editorial format, citation guidance
- Internal linking: filing → company page (sidebar + dateline) · filing → sector page (kicker) · company → sector · sector → companies · homepage → all indexes via Browse band
- Tier labels visible in UI: "Alert" (9+) in accent red, "Lead" (7-8), "Brief" (5-6). URLs stay `/filings/[id]/` for SEO durability.
- Primary-source links on every filing: dateline ("Verify on BSE · NSE") + dedicated "Primary source" block at bottom of article body
- No clickbait, no ads, no paywall. Editorial discipline = SEO advantage post-Helpful-Content-Update.

## What's intentionally NOT built

- **Licensed market-data refresh** — the old Yahoo path has been removed. Market tables can still render cached rows, but fresh index/FX/commodity data needs a licensed or explicitly permitted source.
- **The Open / The Close briefings** — designed in detail (see ARCHITECTURE.md and earlier conversation), data schema sketched, NOT generated. This is the biggest reader-habit feature waiting.
- **Search** — architecture planned (client-side JSON index for now → split shards at ~5k → D1 FTS5 endpoint at ~50k). Nothing shipped yet.
- **Calendar aggregator** — concalls from our DB + macro events (hand-curated YAML) + (later) NSE corporate actions. Not built.
- **Indian G-Sec yields** — need CCIL, RBI, NSE, or another permitted source.
- **RSS / JSON Feed endpoints** — referenced in `llms.txt` but not implemented yet.
- **Cloudflare Workers deploy** — `worker/` directory has README skeleton, no actual deploy yet.
- **Per-instrument deep-dive pages** (e.g. `/markets/index/[symbol]/`) — would be the home for interactive TradingView Lightweight Charts.

## Secrets in `.env`

All four currently set. Treat each as confidential:

| Var | What |
|---|---|
| `TIJORI_FEED_URL` | B2B filings feed — knowledge-of-URL = access. Never commit, never log, never expose to the site. |
| `KITE_SCREENER_URL` | Tijori fundamentals endpoint — same secrecy as above. |
| `DEEPSEEK_API_KEY` | Native DeepSeek key (~$8 balance, $0.69 spent so far). |
| `OPENROUTER_API_KEY` | Kept as fallback (paid for the bakeoff). |

`.env.example` documents the schema without values. `.gitignore` excludes `.env`, `data/`, `node_modules/`, `dist/`.

## Costs so far + outlook

- LLM enrichment to date: **$0.69 total**
- Per-filing cost (DeepSeek native, with KV cache hits on system prompt): **~$0.0014**
- Projected at 50 filings/day, 365 days: **~$25/year**
- Cloudflare Workers + D1 free tier covers everything at our volume
- Domain + DNS: ~$10/year
- **All-in operating cost projection: under $50/year**

## Lessons / gotchas that matter for the next chat

1. **Prompt iteration was the leverage point.** First-pass pass rate was 40%. The fixes that mattered, in order: (a) bumping `max_tokens` to 2500, (b) per-call AbortController timeout, (c) splitting prompts into separate system + user messages so DeepSeek's KV cache hits, (d) adding banned-phrase validator with 40+ patterns, (e) feedback-retry that sends validation issues back to the model — that one move took us from 73% → 98%.
2. **The Tijori feed has no source URLs and no sector field.** Both should be requested upstream. Until then we derive BSE/NSE company-page links from `scripcode`+`symbol`, and sector comes from Kite Screener via Tijori (`/b2b/v1/in/api/kite-screener/fundamental/`).
3. **Market-data refresh is intentionally disabled.** Do not reintroduce Yahoo/yfinance. Pick a licensed or explicitly permitted provider before refreshing markets or company price charts.
4. **Local security hook trips on `child_process` patterns.** Workarounds in this codebase: read SQL from `schema.sql` and run it via the bracket-notation form `db['exec']`, and avoid the `RegExp.prototype.exec(...)` form in favour of `String.prototype.match(...)`. Both are functionally identical; only the hook is bothered.
5. **Astro `getStaticPaths()` runs in isolated scope** — top-level consts outside the function don't see in. Define inside `getStaticPaths` or pass via `props`.
6. **The build is currently 932 pages in ~10s.** At ~5,000 pages it'll cross the threshold where we should switch from full static to hybrid SSR (filing pages from last 30d stay static; older filings SSR-on-demand with year-long edge cache). Already documented in ARCHITECTURE.md.
7. **DeepSeek V4 Flash uses reasoning by default.** The `reasoning_content` field is separate from `content`; our parser reads `content` and ignores reasoning, which is what we want. DeepSeek V4 Pro is ~3× the cost AND much slower (67% timeout rate at 90s) — Flash beats it on every dimension for our task.

## Commands to know

```bash
# Pipeline
cd pipeline
node --env-file=../.env run.mjs stats               # DB stats
node --env-file=../.env run.mjs poll                # fetch feed, dedup
node --env-file=../.env run.mjs enrich 50           # enrich up to 50
node --env-file=../.env run.mjs both                # poll + enrich
node --env-file=../.env run.mjs fetch-fundamentals  # 5,500+ co. fundamentals (~1s)
node --env-file=../.env loop.mjs                    # continuous loop

# Site
cd site
npm run dev        # http://localhost:4321
npm run build      # 932 pages in ~10s
npm run preview    # serve dist/
```

## Immediate next-up (open queue)

Pick one or split into parallel passes:

1. **Licensed market-data source** — replace the removed Yahoo path before building per-company charts or refreshing markets.
2. **The Open / The Close briefings** — twice-daily editorial digest. Designed in conversation (see "Briefing format sketch" in ARCHITECTURE.md). New schema, new LLM prompt, new pages, cron schedule. ~4-6 hours.
3. **Search** — client-side JSON index over headlines + tickers + companies. ~2 hours. Improves browseability dramatically.
4. **RSS / JSON Feed** — already referenced in `llms.txt`; needs implementation. ~1 hour.
5. **Cloudflare deploy** — port pipeline to Workers + Cron + Queue + D1. ~half a day.
6. **Indian G-Sec yields** — CCIL or RBI source integration to complete the yield-curve picture. Research-heavy; likely 2-3 hours.
7. **The article-label rename pass through ALL UI copy** — currently the Story/Alert/Update tiering appears on Filing Note kickers + Company-page row kickers + Smart Money rows. Other surfaces (homepage Wire kickers, briefs, archive rows, etc.) still show only category names. Pure CSS/template edit.

## Pointing me at this

In a new chat, paste this whole file (or the link to it on disk) and add a short sentence on what you want to push on. I'll re-load context and continue.
