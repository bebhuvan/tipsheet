# Tipsheet Architecture Review

Date: 2026-05-27

This is a pragmatic refactor map for the live site and pipeline. The goal is to keep the current product fast and elegant while reducing the operational fragility we saw when scheduled GitHub Actions stopped producing fresh updates.

## Executive Read

The site architecture is good for an MVP: static Astro pages, a single SQLite database, Cloudflare edge delivery, source-grounded editorial generation, and simple GitHub Actions automation. The pain now is not page rendering. It is orchestration, state ownership, and growth boundaries.

The biggest architectural issue is that the database is a release asset passed between independent GitHub workflows. That makes every workflow a potential writer to the same state, forces broad concurrency locking, and encourages full site rebuilds for small data changes. The next phase should separate ingestion, state, build, deploy, and notification into clearer stages.

## Highest Priority Improvements

### 1. Move From Release-Asset SQLite To Durable Production State

Current state:

- Workflows restore `data/filings.db` from the `filings-db-latest` GitHub release asset.
- Workflows publish the whole DB back after each run.
- Most scheduled workflows share `tipsheet-db-${{ github.ref }}` concurrency to avoid DB write races.

Why this becomes painful:

- A missed or dropped scheduled workflow means no ingestion happens.
- Parallel manual catch-up runs queue or cancel behind the same state lock.
- Any workflow can overwrite the current DB if it restored stale state and publishes late.
- GitHub releases are being used as a database transport, which is useful early but brittle long term.

Recommended target:

- D1 is the canonical production database.
- R2 stores DB snapshots/backups and generated artifacts if needed.
- GitHub Actions can still build/deploy code, but should not be the database authority.
- Every ingest job writes idempotently to D1 using natural primary keys.

Refactor order:

1. Add migration files under `pipeline/migrations/`.
2. Make `pipeline/schema.sql` the complete source of truth, or generate D1 migrations from it.
3. Replace the tiny `pipeline/d1-schema.sql` widget-only schema with the full production schema.
4. Add a DB abstraction with two implementations: local SQLite and D1.
5. Move one low-risk stream first, such as `tijori_widgets` or market signals, then filings.

### 2. Separate Ingestion Cadence From Deploy Cadence

Current state:

- Fast News polls, enriches, builds the whole site, deploys, notifies, and republishes the DB.
- Briefings, concalls, macro, RBI, regulatory, and Tijori SDK workflows all repeat similar restore/build/deploy logic.

Why this becomes painful:

- Small data changes trigger full static rebuilds.
- A failed deploy can block notification or state persistence.
- Every workflow repeats dependency install, build, cache, deploy, and DB publish steps.
- Schedule reliability is tied to GitHub Actions cron.

Recommended target:

- Ingestion runs frequently and writes durable state.
- Site deploys run on a predictable cadence or only when enough visible changes exist.
- Notifications run after publication is confirmed, not after ingestion alone.

Practical intermediate step:

- Keep GitHub Actions for now.
- Add a single `publish-site.yml` reusable workflow.
- Make source workflows call it only when content changed.
- Add a Cloudflare Cron watchdog that triggers Fast News if no fresh successful run has occurred within the expected window.

### 3. Make Freshness Observable

Current state:

- We can inspect GitHub Actions manually, but the site has no obvious machine-readable freshness endpoint.
- `continue-on-error` is used for many source fetch/enrich steps, which keeps deployment green but can hide stale data.

Recommended target:

- Add a `pipeline_runs` or `source_health` table:
  - source name
  - started_at
  - completed_at
  - status
  - inserted_count
  - enriched_count
  - error summary
  - source latest timestamp
- Expose `/api/health.json` from the Worker/site.
- Alert Telegram/admin if a critical stream is stale.

Critical streams should fail loudly:

- Fast filings poll.
- DB restore/publish or D1 write.
- Site build/deploy when the run is supposed to publish.

Non-critical streams can stay soft-fail:

- Market strip refresh while the data provider is temporary.
- Optional enrichments where the raw item is already safely stored.

### 4. Add Stable Slugs

Current state:

- Article URLs are derived from `symbol + headline + record_id` at render time.
- If a headline is regenerated, the canonical URL changes.

Why this becomes painful:

- Search engines and social shares can point to old URLs.
- Re-running enrichment or FAQ backfills may accidentally change URL shape if headline logic changes.
- Redirects become hard because the old slug was never stored.

Recommended target:

- Add `slug TEXT UNIQUE` to `filings_enriched` or a separate `content_urls` table.
- Generate it once on first successful enrichment.
- Never mutate it after publication.
- If a headline changes, keep the old slug and update display text only.

This is cheap and should happen before large-scale backfills.

### 5. Introduce Sitemap Indexes Before The Archive Gets Large

Current state:

- `/sitemap.xml` emits one large URL set with filings, companies, sectors, and filters.
- The code asks for up to 50,000 filings and then appends non-filing URLs.

Why this becomes painful:

- Sitemap protocol limit is 50,000 URLs per sitemap.
- At 50,000 filings, the extra company/sector/category URLs push the sitemap over the limit.
- A single huge sitemap is harder to debug and regenerate.

Recommended target:

- `/sitemap.xml` becomes a sitemap index.
- Split into:
  - `/sitemaps/static.xml`
  - `/sitemaps/filings-0001.xml`
  - `/sitemaps/companies.xml`
  - `/sitemaps/sectors.xml`
  - `/sitemap-news.xml`

Do this before 10,000 articles so it is a calm change.

### 6. Shard Search Or Move It To D1 FTS

Current state:

- `/search-index.json` builds one flat client-side index from all filings, companies, and sectors.
- This is elegant at the current scale.

Growth boundary:

- Fine for a few thousand entries.
- Watch the gzipped payload size and client parse time.
- At 10,000 filings, it may still be workable but should be measured.
- At 20,000+, it should be sharded or moved to D1 FTS.

Recommended target:

- Short term: add a build-time size report for `search-index.json`.
- Medium term: monthly shards, loaded on demand.
- Long term: D1 FTS endpoint with ranked server-side search.

### 7. Make The Query Layer Actually Portable To D1

Current state:

- `site/src/lib/queries.mjs` is synchronous and built around `better-sqlite3`.
- The comments say D1 can replace the handle, but D1 is async and returns different shapes.

Why this becomes painful:

- A future D1 migration will touch many call sites at once.
- Static build and Worker runtime need different query capabilities.

Recommended target:

- Create a small repository layer:
  - `createSqliteContentStore(dbPath)`
  - `createD1ContentStore(env.DB)`
- Make methods async even when SQLite resolves immediately.
- Keep SQL shared where possible, but isolate execution and result-shaping.

Do this before switching Astro to hybrid/server mode.

### 8. Normalize Category And Sector Ownership

Current state:

- Raw filings have `event_category_canonical`.
- Enriched filings also have `canonical_category`.
- Queries use both depending on context.
- Sector may come from the LLM-enriched article or from fundamentals, depending on page.

Why this becomes painful:

- Filters, homepage labels, and sitemap/category pages can diverge.
- LLM category output should not override deterministic taxonomy without a clear rule.

Recommended target:

- `filings_raw.event_category_canonical` is the canonical event taxonomy.
- `fundamentals.sector` is the canonical sector taxonomy.
- LLM-provided category/sector can be kept as editorial hints, but not used as routing authority.
- Add `sector_canonical` only if fundamentals coverage is missing and we need a controlled fallback.

### 9. Break Up The Large Astro Pages

Current state:

- `[id].astro` and `radar.astro` are large enough to make future edits risky.
- Homepage is still manageable, but it has many local formatter/helper functions.

Recommended target:

- Extract components for:
  - article header
  - source block
  - fundamentals sidebar
  - briefing ribbon
  - wire row
  - radar card/table sections
- Keep data fetching in pages, rendering in components.

This is not urgent for performance, but it reduces regression risk.

### 10. Align Docs With Reality

Current state:

- The docs still describe Cloudflare Workers + D1 + Queues as the production architecture.
- The live setup is GitHub Actions + SQLite release asset + static Astro deploy to Cloudflare Workers.

Recommended target:

- Keep the future architecture section.
- Add a "Current production architecture" section with the actual state.
- Track migration status explicitly:
  - current
  - transitional
  - target

## Recommended Refactor Order

1. **Operational reliability first**
   - Add freshness/health table.
   - Add `/api/health.json`.
   - Add Cloudflare Cron watchdog for stale GitHub schedules.
   - Reduce hidden failures around critical streams.

2. **State safety**
   - Add immutable slugs.
   - Add migrations directory.
   - Make schema ownership explicit.
   - Stop publishing stale DBs from optional jobs.

3. **Workflow simplification**
   - Create a reusable build/deploy workflow.
   - Gate deploys on actual content changes.
   - Run manual catch-ups sequentially.

4. **Scale boundaries**
   - Sitemap index.
   - Search size report.
   - Search sharding plan.
   - Static recent pages plus dynamic old archive design.

5. **Cloudflare-native migration**
   - Move one non-critical stream to D1.
   - Add D1-backed content store abstraction.
   - Move filings ingestion.
   - Move notification state.
   - Then decide whether old article pages should render dynamically.

6. **Frontend maintainability**
   - Extract large page components.
   - Add a tiny visual smoke-test checklist for homepage, article page, archive, briefing, and search.

## What I Would Not Do Yet

- Do not rewrite the whole site as dynamic SSR immediately. Static Astro is still a strength.
- Do not move everything to Cloudflare Workers in one jump. The current Node/Python pipeline has real shell dependencies.
- Do not add user accounts or personalized watchlists before the ingestion/state architecture is reliable.
- Do not overbuild search before measuring actual payload size and client parse time.

## Near-Term Definition Of Done

The next architectural milestone should be:

- A health endpoint says when each source last produced data.
- A watchdog catches missed schedules.
- Article URLs are immutable.
- Sitemaps cannot break at scale.
- There is one documented schema/migration path.
- Deploy workflows are deduplicated.

That gets Tipsheet through the next order of magnitude without losing the design quality of the current site.
