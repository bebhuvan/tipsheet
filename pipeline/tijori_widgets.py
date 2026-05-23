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
    parser.add_argument("--max-fetch", type=int, default=200, help="Max companies to FETCH from Tijori per run (un-cached first, then stale). Coverage accumulates daily.")
    parser.add_argument("--refresh-days", type=int, default=30, help="Re-fetch a cached company once its data is older than this (quarterly-results refresh).")
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


def cache_fetch_times(data_dir: str) -> dict[str, "datetime"]:
    """{slug: last-fetched datetime} for slugs in the persisted SDK cache.
    Used to skip fresh companies and re-fetch stale ones (quarterly refresh)."""
    from datetime import datetime, timezone

    cat = Path(data_dir) / "catalog.duckdb"
    if not cat.exists():
        return {}
    try:
        import duckdb

        con = duckdb.connect(str(cat), read_only=True)
        rows = con.execute(
            "SELECT slug, MAX(fetched_at) FROM article_widgets WHERE slug IS NOT NULL GROUP BY slug"
        ).fetchall()
        con.close()
    except Exception:
        return {}
    out: dict[str, datetime] = {}
    for slug, fa in rows:
        try:
            dt = datetime.fromisoformat(str(fa))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            out[slug] = dt
        except Exception:
            out[slug] = datetime.now(timezone.utc)  # present but unparseable → treat as fresh
    return out


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

    # Fetch budget per run: first backfill companies NOT yet cached (coverage),
    # then re-fetch cached companies whose data is older than --refresh-days
    # (oldest first) so quarterly results get picked up ~monthly. EXPORT every
    # candidate from the (persisted) cache regardless.
    from datetime import datetime, timezone, timedelta

    times = cache_fetch_times(args.data_dir)
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.refresh_days)
    uncached = [row["slug"] for row in rows if row["slug"] not in times]
    stale = sorted(
        (row["slug"] for row in rows if row["slug"] in times and times[row["slug"]] < cutoff),
        key=lambda s: times[s],
    )
    seen: set[str] = set()
    to_fetch = []
    for slug in [*uncached, *stale]:
        if slug not in seen:
            seen.add(slug)
            to_fetch.append(slug)
        if len(to_fetch) >= args.max_fetch:
            break
    print(f"[tijori-widgets] candidates={len(rows)} cached={len(times)} uncached={len(uncached)} stale={len(stale)} fetch={len(to_fetch)} data_dir={args.data_dir}")

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
