#!/usr/bin/env python3
"""Export Tijori market-dashboard cards into the Tipsheet DB `market_signals` table.

Run AFTER `tijori-scraper market-ingest --data-dir <dir>` has refreshed the cache.
Reads the dashboard idea-cards (Promoter Buying, Whales Buying, Corporate Actions,
Capex, Fundamentals, Trending) and replaces the market_signals snapshot. Powers /alerts/.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import time
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "filings.db"
DEFAULT_DATA_DIR = Path(os.environ.get("TIJORI_MARKET_DIR", ROOT / "data" / "tijori-market"))

SCHEMA = """
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
"""


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export Tijori dashboard cards into market_signals.")
    p.add_argument("--db", default=str(DEFAULT_DB))
    p.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="SDK market cache dir (has catalog.duckdb).")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    catalog = Path(args.data_dir) / "catalog.duckdb"
    if not catalog.exists():
        print(f"[market-signals] no catalog at {catalog} — run `tijori-scraper market-ingest` first")
        return 1

    import json

    out = []  # (category_slug, category_label, company, symbol, metric_name, metric_value, sector, market_cap, source_url, raw_text, row_index, fetched_at)

    with duckdb.connect(str(catalog), read_only=True) as con:
        # 1) Card categories that carry a real signal (skip the company-name-only ones:
        #    Corporate Actions / Capex / Fundamentals / Trending have no usable detail
        #    on the public dashboard).
        cards = con.execute(
            """
            SELECT category_slug, category_label, company_name, symbol, metric_name,
                   metric_value, sector, market_cap, source_url, raw_text, row_index, fetched_at
            FROM dashboard_idea_cards
            WHERE source = 'dashboard' AND category_label IN ('Promoter Buying', 'Whales Buying')
            ORDER BY category_label, row_index
            """
        ).fetchall()
        out.extend(cards)

        # 2) Rating changes — rich detail (agency + new rating + date) from the
        #    table-backed ideas-dashboard page.
        if con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='idea_page_rows'").fetchone()[0]:
            rating = con.execute(
                """
                SELECT group_label, columns_json, source_url, row_index, fetched_at
                FROM idea_page_rows
                WHERE page_slug = 'rating-upgrades'
                ORDER BY table_index, row_index
                """
            ).fetchall()
            for i, (date_label, cols_json, url, _ri, fetched) in enumerate(rating):
                try:
                    cols = json.loads(cols_json) if cols_json else {}
                except Exception:
                    cols = {}
                company = (cols.get("Company") or "").strip()
                agency = (cols.get("Rating Agency") or "").strip()
                ranking = (cols.get("Latest Ranking") or "").strip()
                if not company or not ranking:
                    continue
                out.append((
                    "rating-upgrades", "Rating Upgrades", company, None,
                    agency, ranking, None, cols.get("Market Cap (Cr)"),
                    url, date_label, i, fetched,
                ))

    db = sqlite3.connect(args.db)
    db.executescript(SCHEMA)
    db.execute("DELETE FROM market_signals")  # snapshot table — replace each refresh
    db.executemany(
        """
        INSERT INTO market_signals
          (category_slug, category_label, company_name, symbol, metric_name,
           metric_value, sector, market_cap, source_url, raw_text, row_index, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        out,
    )
    rows = out
    db.commit()
    db.close()
    print(f"[market-signals] exported {len(rows)} cards into market_signals")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
