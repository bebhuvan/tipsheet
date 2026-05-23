#!/usr/bin/env python3
"""Refresh/export compact Tijori SDK article widgets into the Tipsheet DB."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

try:
    from tijori_scraper.sdk import Company, ContractNotFoundError, download
except Exception as exc:  # pragma: no cover - gives a useful CLI error.
    raise SystemExit(
        "Could not import tijori_scraper. Run with the Tijori SDK virtualenv, "
        "or set TIJORI_SDK_PYTHON to its python binary."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "filings.db"
DEFAULT_DATA_DIR = Path(os.environ.get("TIJORI_DATA_DIR", ROOT / "data" / "tijori-cache"))


SCHEMA = """
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
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh Tijori SDK widget cache and export article_widget() JSON into SQLite."
    )
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to Tipsheet SQLite DB.")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR), help="Tijori SDK cache directory.")
    parser.add_argument("--limit", type=int, default=5000, help="Candidate companies to EXPORT from cache (covers the whole archive).")
    parser.add_argument("--max-fetch", type=int, default=200, help="Max companies to FETCH from Tijori per run (un-cached first, then refresh recent). Coverage accumulates daily.")
    parser.add_argument("--symbols", nargs="*", help="Optional explicit NSE symbols to process.")
    parser.add_argument("--cache-only", action="store_true", help="Do not refresh Tijori; only export existing cache.")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--min-interval", type=float, default=0.05)
    return parser.parse_args()


def connect(db_path: str) -> sqlite3.Connection:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def cached_slugs(data_dir: str) -> set[str]:
    """Slugs already present in the persisted SDK cache (so we don't re-fetch them)."""
    cat = Path(data_dir) / "catalog.duckdb"
    if not cat.exists():
        return set()
    try:
        import duckdb

        con = duckdb.connect(str(cat), read_only=True)
        rows = con.execute("SELECT DISTINCT slug FROM article_widgets WHERE slug IS NOT NULL").fetchall()
        con.close()
        return {r[0] for r in rows}
    except Exception:
        return set()


def load_companies(db: sqlite3.Connection, limit: int, symbols: list[str] | None) -> list[sqlite3.Row]:
    params: list[object] = []
    where = [
        "e.validation_ok = 1",
        "r.symbol IS NOT NULL",
        "f.tijori_slug IS NOT NULL",
        "f.tijori_slug != ''",
    ]
    if symbols:
        placeholders = ",".join("?" for _ in symbols)
        where.append(f"r.symbol IN ({placeholders})")
        params.extend(s.upper() for s in symbols)

    params.append(limit)
    return db.execute(
        f"""
        SELECT
          r.symbol,
          MAX(r.company) AS company,
          f.tijori_slug AS slug,
          MAX(r.created_on) AS latest_article
        FROM filings_raw r
        JOIN filings_enriched e ON e.record_id = r.record_id
        JOIN fundamentals f ON f.symbol = r.symbol
        WHERE {" AND ".join(where)}
        GROUP BY r.symbol, f.tijori_slug
        ORDER BY MAX(r.created_on) DESC
        LIMIT ?
        """,
        params,
    ).fetchall()


def export_widget(db: sqlite3.Connection, symbol: str, slug: str, data_dir: str) -> tuple[bool, str]:
    try:
        widget = Company(slug, data_dir=data_dir, cache_only=True, max_age=None).article_widget()
    except ContractNotFoundError as exc:
        return False, str(exc)

    db.execute(
        """
        INSERT INTO tijori_widgets
          (symbol, slug, company_name, payload_json, schema_version, source_run_id, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          slug=excluded.slug,
          company_name=excluded.company_name,
          payload_json=excluded.payload_json,
          schema_version=excluded.schema_version,
          source_run_id=excluded.source_run_id,
          fetched_at=excluded.fetched_at
        """,
        (
            symbol,
            widget.get("slug") or slug,
            widget.get("name"),
            json.dumps(widget, ensure_ascii=False, separators=(",", ":")),
            str(widget.get("schema_version") or ""),
            widget.get("run_id"),
            int(time.time() * 1000),
        ),
    )
    return True, widget.get("name") or symbol


def main() -> int:
    args = parse_args()
    db = connect(args.db)
    rows = load_companies(db, args.limit, args.symbols)
    if not rows:
        print("[tijori-widgets] no companies to process")
        return 0

    # Fetch budget per run: prioritise companies NOT yet in the cache (backfill
    # coverage), then spend any leftover quota refreshing the most-recent ones
    # (freshness). EXPORT every candidate from the cache. With the cache
    # persisted across runs, coverage reaches the whole archive in a few days.
    have = cached_slugs(args.data_dir)
    uncached = [row["slug"] for row in rows if row["slug"] not in have]
    to_fetch = uncached[: args.max_fetch]
    if len(to_fetch) < args.max_fetch:
        for row in rows[: args.max_fetch - len(to_fetch)]:
            if row["slug"] not in to_fetch:
                to_fetch.append(row["slug"])
    print(f"[tijori-widgets] candidates={len(rows)} cached={len(have)} fetch={len(to_fetch)} data_dir={args.data_dir}")

    if not args.cache_only and to_fetch:
        issues = download(
            to_fetch,
            data_dir=args.data_dir,
            workers=args.workers,
            min_interval=args.min_interval,
            preset="widget",
            optional_endpoints=False,
            raw_snapshots=False,
        )
        if issues:
            print(f"[tijori-widgets] refresh issues={len(issues)}")
            for issue in issues[:10]:
                print(f"  issue: {issue}")

    ok = fail = 0
    for row in rows:
        success, detail = export_widget(db, row["symbol"], row["slug"], args.data_dir)
        if success:
            ok += 1
            print(f"  ok   {row['symbol']:<12} {detail}")
        else:
            fail += 1
            print(f"  miss {row['symbol']:<12} {detail}", file=sys.stderr)
    db.commit()
    print(f"[tijori-widgets] exported={ok} missed={fail}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
