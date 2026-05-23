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
