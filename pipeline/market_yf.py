#!/usr/bin/env python3
"""Pull Indian index moves + per-stock weekly price history from yfinance.

Two jobs, both writing into the Tipsheet DB so the site never touches a market
data provider at build/runtime (licensing — site reads only the DB):

  1. market_snapshots — latest level + day move for the briefing breadth ladder
     and major NSE sectoral indices.
  2. market_history   — ~1 week of daily closes for the stocks most likely to
     appear in the next briefing (top filings by score in the window). Powers the
     per-stock sparkline in each briefing event item.

Run before `make briefing-open` / `briefing-close`.

  python3 market_yf.py                 # indices + history for recent top filings
  python3 market_yf.py --hours 36      # widen the filing window for history
  python3 market_yf.py --symbols A,B   # history for an explicit symbol list
  python3 market_yf.py --no-history    # indices only
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "filings.db"

# Yahoo symbol -> (display name, group). grp matches the market_snapshots convention.
INDICES = {
    "^NSEI": ("Nifty 50", "broad"),
    "^BSESN": ("Sensex", "broad"),
    "^NSEBANK": ("Bank Nifty", "broad"),
    "^INDIAVIX": ("India VIX", "broad"),
    "NIFTY_TOTAL_MKT.NS": ("Nifty Total Market", "broad"),
    "NIFTY_500.NS": ("Nifty 500", "broad"),
    "NIFTY_MIDCAP_150.NS": ("Nifty Midcap 150", "broad"),
    "NIFTY_SMLCAP_250.NS": ("Nifty Smallcap 250", "broad"),
    "NIFTY_MICROCAP250.NS": ("Nifty Microcap 250", "broad"),
    "^CNXAUTO": ("Nifty Auto", "sector"),
    "^CNXENERGY": ("Nifty Energy", "sector"),
    "^CNXFIN": ("Nifty Financial Services", "sector"),
    "^CNXFMCG": ("Nifty FMCG", "sector"),
    "^CNXIT": ("Nifty IT", "sector"),
    "^CNXMEDIA": ("Nifty Media", "sector"),
    "^CNXMETAL": ("Nifty Metal", "sector"),
    "^CNXPHARMA": ("Nifty Pharma", "sector"),
    "^CNXPSUBANK": ("Nifty PSU Bank", "sector"),
    "^CNXREALTY": ("Nifty Realty", "sector"),
    "NIFTY_CEMENT.NS": ("Nifty Cement", "sector"),
    "NIFTY_CHEMICALS.NS": ("Nifty Chemicals", "sector"),
    "NIFTY_CONSR_DURBL.NS": ("Nifty Consumer Durables", "sector"),
    "NIFTY_HEALTHCARE.NS": ("Nifty Healthcare", "sector"),
    "NIFTY_OIL_AND_GAS.NS": ("Nifty Oil & Gas", "sector"),
    "NIFTY_REITS_REALTY.NS": ("Nifty REITs & Realty", "sector"),
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Fetch Indian index moves + stock weekly history via yfinance.")
    p.add_argument("--db", default=str(DEFAULT_DB))
    p.add_argument("--hours", type=int, default=36, help="Look-back window for picking history stocks from top filings.")
    p.add_argument("--limit", type=int, default=24, help="Max stocks to fetch history for.")
    p.add_argument("--symbols", default=None, help="Explicit comma-separated NSE symbols (overrides the filing query).")
    p.add_argument("--no-indices", action="store_true", help="Skip the index snapshot fetch.")
    p.add_argument("--no-history", action="store_true", help="Skip the per-stock history fetch.")
    return p.parse_args()


def _last_two_closes(hist) -> tuple[float | None, float | None]:
    """Return (latest_close, prev_close) from a yfinance history DataFrame."""
    if hist is None or hist.empty or "Close" not in hist:
        return None, None
    closes = [float(c) for c in hist["Close"].tolist() if c == c]  # drop NaN
    if not closes:
        return None, None
    latest = closes[-1]
    prev = closes[-2] if len(closes) >= 2 else None
    return latest, prev


def fetch_indices(db: sqlite3.Connection) -> int:
    rows = []
    now = int(time.time() * 1000)
    for sym, (name, grp) in INDICES.items():
        try:
            hist = yf.Ticker(sym).history(period="5d", interval="1d", auto_adjust=False)
        except Exception as e:  # network / symbol hiccup — skip, keep the rest
            print(f"[yf] {sym}: history failed ({e})")
            continue
        price, prev = _last_two_closes(hist)
        if price is None:
            print(f"[yf] {sym}: no close data")
            continue
        change_abs = (price - prev) if prev is not None else None
        change_pct = ((price - prev) / prev * 100) if prev else None
        rows.append((now, sym, name, grp, price, change_abs, change_pct, prev, "yfinance"))
        pct = f"{change_pct:+.2f}%" if change_pct is not None else "n/a"
        print(f"[yf] {name:<11} {price:>12,.2f}  {pct}")

    if rows:
        db.executemany(
            """INSERT INTO market_snapshots
                 (fetched_at, symbol, name, grp, price, change_abs, change_pct, prev_close, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        db.commit()
    return len(rows)


def history_symbols(db: sqlite3.Connection, hours: int, limit: int) -> list[str]:
    cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - hours * 3600))
    rows = db.execute(
        """SELECT DISTINCT r.symbol
             FROM filings_raw r
             JOIN filings_enriched e ON e.record_id = r.record_id
            WHERE e.validation_ok = 1 AND r.symbol IS NOT NULL AND r.symbol != ''
              AND r.created_on >= ?
            ORDER BY r.score DESC, r.created_on DESC
            LIMIT ?""",
        (cutoff, limit),
    ).fetchall()
    return [r[0] for r in rows]


def fetch_history(db: sqlite3.Connection, symbols: list[str]) -> int:
    """Fetch ~1 week of daily closes per symbol. Try NSE (.NS) then BSE (.BO)."""
    written = 0
    for sym in symbols:
        series = None
        for suffix in (".NS", ".BO"):
            try:
                hist = yf.Ticker(sym + suffix).history(period="1mo", interval="1d", auto_adjust=False)
            except Exception:
                continue
            if hist is not None and not hist.empty and "Close" in hist:
                series = hist
                break
        if series is None:
            print(f"[yf] {sym}: no NSE/BSE history")
            continue
        # Keep the last ~7 trading days for a one-week sparkline.
        tail = series.tail(7)
        points = [
            (sym, idx.strftime("%Y-%m-%d"), float(close))
            for idx, close in zip(tail.index, tail["Close"].tolist())
            if close == close
        ]
        if len(points) < 2:
            print(f"[yf] {sym}: too few points")
            continue
        db.executemany(
            "INSERT OR REPLACE INTO market_history (symbol, date, close) VALUES (?, ?, ?)",
            points,
        )
        written += 1
        print(f"[yf] {sym:<12} {len(points)} closes  {points[0][2]:.1f} -> {points[-1][2]:.1f}")
    db.commit()
    return written


def main() -> int:
    args = parse_args()
    db = sqlite3.connect(args.db)

    if not args.no_indices:
        n = fetch_indices(db)
        print(f"[yf] indices: {n}/{len(INDICES)} snapshots written")

    if not args.no_history:
        if args.symbols:
            syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        else:
            syms = history_symbols(db, args.hours, args.limit)
        print(f"[yf] history: {len(syms)} stocks to fetch")
        if syms:
            w = fetch_history(db, syms)
            print(f"[yf] history: {w}/{len(syms)} stocks written")

    db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
