# D1 Migration Runbook (Phases 3–5)

Activation guide for the reliability refactor's Cloudflare-native phases. Code
for these is committed but **inert** — nothing changes in production until you
run these steps. Order matters: each phase is independently reversible.

Prereqs: `wrangler` v4 logged in (`wrangler login`), the repo's `CLOUDFLARE_ACCOUNT_ID`.

---

## Phase 3 — D1 as a read-replica (no ingest change, no URL change)

Model: SQLite (the `filings-db-latest` release asset) stays the source of truth
and the build keeps reading it. D1 is a replica for runtime SSR, kept current by
`pipeline/sync-to-d1.mjs`. Ingestion is untouched, so this cannot corrupt state.

1. **Create (or reuse) the D1 database.** A widget D1 already exists
   (`4645967f-e1aa-4291-b023-5509fcddb758`). Either reuse it or create a dedicated one:
   ```
   wrangler d1 create tipsheet-content
   ```
   Note the returned `database_id`.

2. **Apply the schema.** `pipeline/schema.sql` is D1-compatible:
   ```
   wrangler d1 execute tipsheet-content --remote --file=pipeline/schema.sql
   ```
   Circulars/RBI/alphastreet/macro tables aren't in schema.sql (their pollers
   create them). Export their DDL from SQLite and apply once:
   ```
   sqlite3 data/filings.db ".schema circulars_raw circulars_enriched rbi_raw rbi_enriched alphastreet_raw alphastreet_enriched macro_enriched company_snapshots" > /tmp/extra.sql
   wrangler d1 execute tipsheet-content --remote --file=/tmp/extra.sql
   ```

3. **Seed + validate parity.** Set `D1_DATABASE_ID` (+ `CLOUDFLARE_*`) and run a
   full sync, then spot-check counts:
   ```
   D1_DATABASE_ID=<id> node --env-file=../.env sync-to-d1.mjs --full
   # dry-run first if unsure: append --dry-run (no creds/network needed)
   wrangler d1 execute tipsheet-content --remote --command \
     "SELECT (SELECT COUNT(*) FROM filings_enriched) enriched, (SELECT COUNT(*) FROM filings_raw) raw"
   ```
   Compare against `node run.mjs stats`. They should match.

4. **Wire the sync into CI.** Add a step to `tijori-sdk.yml` (or a small
   `d1-sync.yml` on a schedule) after the DB is published:
   ```yaml
   - name: Sync content to D1
     run: cd pipeline && node --env-file=../.env.ci sync-to-d1.mjs
     env:
       CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
       CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
       D1_DATABASE_ID: ${{ secrets.D1_DATABASE_ID }}
     continue-on-error: true   # replica lag is non-critical; source_health records it
   ```
   Routine runs are incremental (watermark in `_d1_sync_state`); `--full` re-seeds.

**Rollback:** stop running the sync. Nothing reads D1 yet (Phase 4 does), so
there is no production impact.

---

## Phase 4 — Hybrid rendering (the only URL-sensitive step)

Goal: Tier-1 (recent + landing pages) stay prerendered; Tier-2 (old archive)
renders on-demand from D1 and is edge-cached for a year. **Do not start until
Phase 3 parity is confirmed.**

1. **Install the adapter** and flip output:
   ```
   cd site && npm i @astrojs/cloudflare
   ```
   `astro.config.mjs`: `output: 'server'`, `adapter: cloudflare()`. Keep
   `trailingSlash: 'always'` (already pinned).

2. **Tier-1 stays static.** Add `export const prerender = true;` to: homepage,
   all landing/category/sector/company/markets pages, briefings, feeds, sitemaps,
   and `getStaticPaths` in `filings/[id].astro` returns only the last ~60 days.

3. **Tier-2 reads D1 via the store.** Older `[id].astro` requests fall through to
   SSR: `const store = getStore(Astro.locals.runtime.env)` →
   `await store.getFiling(...)`. Implement the D1 read paths in
   `createD1Store()` (content-store.mjs) — reuse the SQL from queries.mjs. Set
   `Cache-Control: public, max-age=31536000, immutable` on Tier-2 responses (old
   filings never change). Bind D1 in `site/wrangler.toml`:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "tipsheet-content"
   database_id = "<id>"
   ```

4. **URL-safety gate (mandatory).** Before flipping, capture the current route
   inventory and diff after — it MUST be empty:
   ```
   cd site && npm run build && find dist -name '*.html' | sed 's#dist##;s#/index.html#/#' | sort > /tmp/routes-before.txt
   # after the change, rebuild and diff; investigate ANY delta before deploying
   ```
   Belt-and-suspenders: a Cloudflare Redirect Rule 301s any legacy slug to its
   canonical (safe because `recordIdFromSlug` routes off the trailing `-<id>`).

5. **Cache stack.** Enable Tiered Cache + Cache Reserve so cold long-tail hits
   stay warm instead of falling through to SSR. On publish, purge only changed
   URLs (homepage, the new slug, its category) instead of the whole site.

**Rollback:** revert `output` to `'static'` and redeploy — back to today's model.

---

## Phase 5 — CF-native ingestion + observability (optional polish)

- **Queues:** poller → Queue of new record_ids → enricher consumer
  (concurrency 8, built-in retries/backoff). Replaces inline enrich +
  `continue-on-error`.
- **Cron Triggers:** move pollers off GitHub cron (which silently drops runs).
  The watchdog (`worker/watchdog`) already runs on CF cron.
- **Durable Object:** exactly-once Telegram notify + a poll-lock so two ingest
  runs can't double-process. Replaces the `notified_at` + shared-lock approach.
- **Workers Analytics Engine:** freshness/latency/error telemetry without a
  table. **KV:** edge health snapshot read per-request without a D1 hit.
- **Smart Placement:** place the SSR Worker near D1.

These are independent; adopt whichever pays off first. None are required for the
reliability wins in Phases 0–3.

---

## Status of supporting code (committed, inert)

| Artifact | State |
|---|---|
| `pipeline/sync-to-d1.mjs` | Done. Dry-run validated against all 20 tables (16,534 rows). Needs `D1_DATABASE_ID` + a created DB to run live. |
| `site/src/lib/content-store.mjs` | Async seam done (`createSqliteStore`). `createD1Store` reads implemented during Phase 4 step 3. |
| `pipeline/schema.sql` | D1-compatible; the canonical schema to apply in Phase 3 step 2. |
| `worker/watchdog/` | Done (Phase 1). Already CF-cron-native. |
