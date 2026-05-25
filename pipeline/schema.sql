-- D1-compatible schema. Same SQL runs on local SQLite (better-sqlite3) and Cloudflare D1.

CREATE TABLE IF NOT EXISTS filings_raw (
  record_id                INTEGER PRIMARY KEY,
  symbol                   TEXT,
  scripcode                INTEGER,
  company                  TEXT,
  score                    INTEGER NOT NULL,
  sentiment                TEXT,
  event_type               TEXT,
  event_category_raw       TEXT,
  event_category_canonical TEXT,
  rationale                TEXT,
  news_summary             TEXT,
  major_order              INTEGER DEFAULT 0,
  major_order_size         TEXT,
  famous_investor_meeting  INTEGER DEFAULT 0,
  investor_name            TEXT,
  concall_to_join          INTEGER DEFAULT 0,
  created_on               TEXT NOT NULL,
  raw_json                 TEXT,
  inserted_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_created_on ON filings_raw(created_on);
CREATE INDEX IF NOT EXISTS idx_raw_symbol     ON filings_raw(symbol);
CREATE INDEX IF NOT EXISTS idx_raw_score      ON filings_raw(score);
CREATE INDEX IF NOT EXISTS idx_raw_canonical  ON filings_raw(event_category_canonical);

CREATE TABLE IF NOT EXISTS filings_enriched (
  record_id              INTEGER PRIMARY KEY,
  headline               TEXT,
  dek                    TEXT,
  the_number_value       TEXT,
  the_number_label       TEXT,
  whats_new              TEXT,
  why_it_matters         TEXT,
  what_were_watching     TEXT,
  the_full_read          TEXT,
  editorial_tone         TEXT,
  tone_score             INTEGER,
  tone_confidence        TEXT,
  tone_reason            TEXT,
  canonical_category     TEXT,
  sector                 TEXT,
  faqs                   TEXT,
  key_entities           TEXT,
  model_used             TEXT,
  prompt_version         TEXT,
  enriched_at            INTEGER NOT NULL,
  validation_ok          INTEGER NOT NULL,
  validation_issues      TEXT,
  FOREIGN KEY (record_id) REFERENCES filings_raw(record_id)
);

CREATE INDEX IF NOT EXISTS idx_enriched_category ON filings_enriched(canonical_category);
CREATE INDEX IF NOT EXISTS idx_enriched_sector   ON filings_enriched(sector);
CREATE INDEX IF NOT EXISTS idx_enriched_ok       ON filings_enriched(validation_ok);

-- Market snapshots — append-only history of every fetched quote.
-- "Current" = MAX(fetched_at) per symbol. Never UPDATE; always INSERT.
CREATE TABLE IF NOT EXISTS market_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at      INTEGER NOT NULL,
  symbol          TEXT NOT NULL,
  name            TEXT,
  grp             TEXT,                  -- 'broad' | 'sector' | 'fx' | 'commodity' | 'stock'
  price           REAL,
  change_abs      REAL,
  change_pct      REAL,
  prev_close      REAL,
  day_high        REAL,
  day_low         REAL,
  week52_high     REAL,
  week52_low      REAL,
  volume          INTEGER,
  currency        TEXT,
  market_state    TEXT,
  source          TEXT,                  -- licensed/permitted provider id
  raw_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_market_symbol_time ON market_snapshots(symbol, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_grp_time    ON market_snapshots(grp, fetched_at DESC);

-- Daily close prices — for sparklines on Markets page. UNIQUE (symbol, date) so re-fetching
-- the same day is idempotent.
CREATE TABLE IF NOT EXISTS market_history (
  symbol     TEXT NOT NULL,
  date       TEXT NOT NULL,
  close      REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_history_symbol_date ON market_history(symbol, date DESC);

-- ─── Briefings: The Open / The Close ────────────────────────────────
-- Twice-daily editorial digest. "open" generated ~8:45 IST before market opens; "close"
-- generated ~16:00 IST after market closes. Each briefing has a headline + dek + a JSON
-- sections array (each section: { label, body, items: [...] }).
CREATE TABLE IF NOT EXISTS briefings (
  type            TEXT NOT NULL,                -- 'open' | 'close'
  date            TEXT NOT NULL,                -- YYYY-MM-DD (IST)
  headline        TEXT,
  dek             TEXT,
  the_take        TEXT,                         -- one-line Lex sign-off
  sections        TEXT,                         -- JSON array of { label, body, items }
  input_summary   TEXT,                         -- JSON snapshot of what was fed to the LLM (audit trail)
  generated_at    INTEGER NOT NULL,
  model_used      TEXT,
  prompt_version  TEXT,
  validation_ok   INTEGER NOT NULL,
  validation_issues TEXT,
  PRIMARY KEY (type, date)
);
CREATE INDEX IF NOT EXISTS idx_briefings_date ON briefings(date DESC);

-- ─── India Data Hub: macro calendar ─────────────────────────────────
-- Scheduled economic events (CPI, IIP, GDP, PMI, central bank decisions, trade data, etc.)
-- pulled from /newsfeed/calendar. PK = (date, identifier, country_code) — same event may be
-- forecast then re-published with actual, so we ON CONFLICT REPLACE to keep the latest.
CREATE TABLE IF NOT EXISTS macro_calendar (
  date           TEXT NOT NULL,
  identifier     TEXT,                          -- IDH series id ('TRMERTB16SGCM') — may be null
  country_code   TEXT,                          -- ISO 3166-1 alpha-2
  coverage       TEXT,                          -- 'Global' / 'India' / region name
  indicator      TEXT NOT NULL,
  period         TEXT,                          -- ISO date of the reporting period
  previous_val   REAL,
  forecast_val   REAL,
  actual_val     REAL,
  category       TEXT,                          -- 'External Trade' / 'Monetary' / etc.
  unit           TEXT,                          -- 'US$ bn' / '% YoY' / 'index' / etc.
  frequency      TEXT,                          -- M / Q / Y / D / W
  impact         TEXT,                          -- H / M / L
  date_type      TEXT,                          -- A = announced date, T = tentative
  event_flag     INTEGER DEFAULT 0,
  raw_json       TEXT,
  fetched_at     INTEGER NOT NULL,
  PRIMARY KEY (date, identifier, country_code)
);
CREATE INDEX IF NOT EXISTS idx_macro_calendar_date     ON macro_calendar(date);
CREATE INDEX IF NOT EXISTS idx_macro_calendar_country  ON macro_calendar(country_code);
CREATE INDEX IF NOT EXISTS idx_macro_calendar_impact   ON macro_calendar(impact);

-- ─── Tijori Concall Monitor ─────────────────────────────────────────
-- Raw concalls pulled from https://www.tijoristack.ai/api/v1/concalls/list/.
-- Editorial rule: brief Filings Concall Notes link back to Tijori; never reproduce
-- the full transcript or full ai_summary on the Filings site.
CREATE TABLE IF NOT EXISTS concalls_raw (
  isin                    TEXT NOT NULL,
  event_time              TEXT NOT NULL,         -- ISO from concall_event_time
  symbol                  TEXT,                  -- mapped from isin via fundamentals when possible
  company_name            TEXT,
  sector                  TEXT,
  slug                    TEXT,                  -- Tijori slug
  status                  TEXT,                  -- 'recorded' | 'Upcoming'
  recording_url           TEXT,
  transcript_url          TEXT,
  transcript_source       TEXT,
  summary_highlight       TEXT,                  -- short headline-like phrase ("Kavach Cleared")
  management_consistency  TEXT,                  -- JSON-stringified — UNIQUE IP (mgmt flip-flop flags)
  ai_summary              TEXT,                  -- JSON-stringified full analytical block (do not republish)
  raw_json                TEXT,
  fetched_at              INTEGER NOT NULL,
  PRIMARY KEY (isin, event_time)
);
CREATE INDEX IF NOT EXISTS idx_concalls_symbol     ON concalls_raw(symbol);
CREATE INDEX IF NOT EXISTS idx_concalls_event_time ON concalls_raw(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_concalls_sector     ON concalls_raw(sector);

-- Editorial output: the Filings Concall Note. Same shape philosophy as filings_enriched
-- but tuned for a ~150-word brief, with management-consistency flag as the lede when present.
CREATE TABLE IF NOT EXISTS concalls_enriched (
  isin                    TEXT NOT NULL,
  event_time              TEXT NOT NULL,
  headline                TEXT,
  dek                     TEXT,
  the_take                TEXT,                  -- one-line editorial take
  inconsistency_flag      TEXT,                  -- the lede when mgmt-consistency surfaces a contradiction
  whats_new               TEXT,                  -- JSON array
  key_quotes              TEXT,                  -- JSON array of {quote, attribution}
  the_brief               TEXT,                  -- 120-180 word editorial brief
  canonical_category      TEXT DEFAULT 'Concalls',
  model_used              TEXT,
  prompt_version          TEXT,
  enriched_at             INTEGER NOT NULL,
  validation_ok           INTEGER NOT NULL,
  validation_issues       TEXT,
  PRIMARY KEY (isin, event_time),
  FOREIGN KEY (isin, event_time) REFERENCES concalls_raw(isin, event_time)
);

-- Per-symbol fundamentals from Tijori Kite Screener. Refreshed on each fast news run.
-- Authoritative sector taxonomy lives here.
CREATE TABLE IF NOT EXISTS fundamentals (
  symbol           TEXT PRIMARY KEY,
  isin             TEXT,
  sector           TEXT,
  market_cap       REAL,
  pe               REAL,
  roe              REAL,
  debt_to_equity   REAL,
  dividend_yield   REAL,
  free_cash_flow   REAL,
  revenue_growth   REAL,
  pat_growth       REAL,
  low_52w          REAL,
  high_52w         REAL,
  tijori_slug      TEXT,
  raw_json         TEXT,
  fetched_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fundamentals_sector ON fundamentals(sector);
CREATE INDEX IF NOT EXISTS idx_fundamentals_mcap   ON fundamentals(market_cap DESC);

-- Compact per-company article widgets exported from the Tijori SDK cache.
-- This is the production-safe path for article-page financial modules:
-- a scheduled/background job refreshes the SDK cache, exports JSON here,
-- and the static site reads this table at build time. Article rendering must
-- not scrape Tijori or make live SDK calls.
CREATE TABLE IF NOT EXISTS tijori_widgets (
  symbol          TEXT PRIMARY KEY,
  slug            TEXT,
  company_name    TEXT,
  payload_json    TEXT NOT NULL,
  schema_version  TEXT,
  source_run_id   TEXT,
  fetched_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tijori_widgets_slug ON tijori_widgets(slug);

-- ─── Radar: editorial discovery candidates ─────────────────────────
-- Rule-generated company situations worth exploring. This is not a recommendation
-- engine: it records why a company is interesting now, with source evidence and
-- caveats, then links readers to Tipsheet notes and Tijori Finance research.
CREATE TABLE IF NOT EXISTS radar_items (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                TEXT NOT NULL,
  company               TEXT,
  trigger_type          TEXT NOT NULL,            -- 'filing_cluster' | 'order_win' | 'smart_money' | 'concall_watch' | 'quality_breakout'
  title                 TEXT,
  why_now               TEXT,
  evidence_record_ids   TEXT,                     -- JSON array of filings_raw.record_id
  quality_flags         TEXT,                     -- JSON array of short strings
  risk_flags            TEXT,                     -- JSON array of short strings
  radar_score           REAL NOT NULL,
  tijori_slug           TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  generated_at          INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  why_now_hash          TEXT,                     -- content hash of (symbol, trigger, evidence_ids, flags) for LLM cache
  why_now_source        TEXT DEFAULT 'template',  -- 'template' | 'llm' | 'failed'
  UNIQUE(symbol, trigger_type)
);
CREATE INDEX IF NOT EXISTS idx_radar_status_score ON radar_items(status, radar_score DESC);
CREATE INDEX IF NOT EXISTS idx_radar_symbol       ON radar_items(symbol);

-- Market signals — Tijori dashboard idea-cards (promoter/whale buying, corporate
-- actions, capex, fundamentals, trending). Snapshot table, replaced each refresh.
CREATE TABLE IF NOT EXISTS market_signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  category_slug  TEXT,
  category_label TEXT,
  company_name   TEXT,
  symbol         TEXT,
  metric_name    TEXT,
  metric_value   TEXT,
  sector         TEXT,
  market_cap     TEXT,
  source_url     TEXT,
  raw_text       TEXT,
  row_index      INTEGER,
  fetched_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_market_signals_cat ON market_signals(category_slug, row_index);
