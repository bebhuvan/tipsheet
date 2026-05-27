ALTER TABLE filings_enriched ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enriched_slug
  ON filings_enriched(slug)
  WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_health (
  source              TEXT PRIMARY KEY,
  status              TEXT NOT NULL,
  started_at          INTEGER,
  completed_at        INTEGER,
  last_success_at     INTEGER,
  inserted_count      INTEGER,
  enriched_count      INTEGER,
  item_count          INTEGER,
  latest_source_time  TEXT,
  error               TEXT,
  meta_json           TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_health_status ON source_health(status);
CREATE INDEX IF NOT EXISTS idx_source_health_success ON source_health(last_success_at DESC);
