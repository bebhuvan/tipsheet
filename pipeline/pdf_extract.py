#!/usr/bin/env python3
"""Source-PDF extractor for circulars (and later RBI/MOSPI/legal orders).

CI-friendly: the only third-party dependency is `pdfplumber` (pure-pip, pdfminer-based,
no system binaries like poppler). Everything else is stdlib. Matches the repo's existing
"pip install <pkg> inline in the workflow" pattern (see pipeline.yml market_yf step).

Why deterministic extraction (not "pass the PDF to the LLM"):
  The stock LISTS are the SEO payload and they must be COMPLETE and EXACT. An LLM will
  silently drop/merge/invent rows. So we extract the table verbatim here; the LLM only ever
  writes the prose AROUND this table, never the table itself.

Handles the two real-world wrinkles:
  - NSE pdfUrl is sometimes a .zip of nested PDFs  → unzip, take the first PDF.
  - Tables come out with layout padding (empty cells) → cleaned to tidy rows.

Usage:
  python3 pdf_extract.py url <PDF_OR_ZIP_URL>          # print {text, tables} JSON
  python3 pdf_extract.py circular <circular_id>        # read pdf_url from DB, extract, store
      [--db ../data/filings.db]
"""
from __future__ import annotations
import argparse
import io
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
import zipfile

# Exchange/RBI sites block non-browser requests, so identify as a browser. Plain document
# retrieval, not evasion.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/121.0.0.0 Safari/537.36")


def fetch_bytes(url: str, timeout: int = 40) -> bytes:
    headers = {
        "User-Agent": UA,
        # IMPORTANT: a browser-style Accept is required for rbidocs.rbi.org.in — a narrow
        # "application/pdf" Accept makes RBI's server return an HTML fallback instead of the PDF.
        "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    if "rbi.org.in" in url:
        headers["Referer"] = "https://www.rbi.org.in/"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def pdf_bytes_from(url: str) -> bytes:
    """Return PDF bytes for a url that may be a direct PDF or a .zip of PDFs."""
    raw = fetch_bytes(url)
    # ZIP magic 'PK\x03\x04' or .zip extension → pull the first PDF inside.
    if raw[:4] == b"PK\x03\x04" or url.lower().endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            pdfs = [n for n in z.namelist() if n.lower().endswith(".pdf")]
            if not pdfs:
                raise ValueError("zip contains no PDF: " + ", ".join(z.namelist()[:5]))
            return z.read(pdfs[0])
    return raw


def clean_table(rows: list[list]) -> list[list[str]]:
    """Collapse layout padding: drop empty cells, drop empty/separator rows."""
    out = []
    for row in rows:
        cells = [(c or "").replace("\n", " ").strip() for c in row]
        cells = [c for c in cells if c and c not in ("-", "--", "---")]
        if not cells:
            continue
        # Skip pure-separator rows (all cells are dashes already filtered; guard anyway)
        if all(set(c) <= {"-"} for c in cells):
            continue
        out.append(cells)
    # A real table needs at least a header-ish row + one data row.
    return out if len(out) >= 2 else []


def extract(pdf: bytes) -> dict:
    import pdfplumber  # imported here so `--help` works without the dep installed
    text_parts, tables = [], []
    with pdfplumber.open(io.BytesIO(pdf)) as doc:
        n_pages = len(doc.pages)
        for page in doc.pages:
            t = page.extract_text() or ""
            if t:
                text_parts.append(t)
            for raw in page.extract_tables() or []:
                cleaned = clean_table(raw)
                if cleaned:
                    tables.append(cleaned)
    return {"pages": n_pages, "text": "\n\n".join(text_parts), "tables": tables}


# ─── DB integration (same data/filings.db bus the Node pipeline uses) ───
def ensure_columns(con: sqlite3.Connection) -> None:
    cols = {r[1] for r in con.execute("PRAGMA table_info(circulars_raw)")}
    for name, typ in (("pdf_text", "TEXT"), ("pdf_tables", "TEXT"), ("pdf_extracted_at", "INTEGER")):
        if name not in cols:
            con.execute(f"ALTER TABLE circulars_raw ADD COLUMN {name} {typ}")
    con.commit()


def extract_for_circular(circular_id: str, db_path: str) -> dict:
    con = sqlite3.connect(db_path)
    ensure_columns(con)
    row = con.execute("SELECT pdf_url, title FROM circulars_raw WHERE circular_id = ?", (circular_id,)).fetchone()
    if not row:
        con.close()
        raise SystemExit(f"circular {circular_id} not found")
    pdf_url, title = row
    if not pdf_url:
        con.close()
        raise SystemExit(f"circular {circular_id} has no pdf_url")
    result = extract(pdf_bytes_from(pdf_url))
    con.execute(
        "UPDATE circulars_raw SET pdf_text = ?, pdf_tables = ?, pdf_extracted_at = ? WHERE circular_id = ?",
        (result["text"], json.dumps(result["tables"], ensure_ascii=False), int(time.time()), circular_id),
    )
    con.commit()
    con.close()
    return {"circular_id": circular_id, "title": title, "pages": result["pages"],
            "text_chars": len(result["text"]), "tables": len(result["tables"]),
            "table_rows": [len(t) for t in result["tables"]]}


# ─── RBI Bulletin: discover article PDFs → extract text → rbi_raw (kind='bulletin') ───
# The Bulletin page lists ~67 PDFs; most are statistical-table appendices (…T_BULL…). We keep
# the editorial articles (State of the Economy + research pieces) and write their extracted text
# into rbi_raw so the Node RBI enricher (DeepSeek) summarises them into /economy notes.
BULLETIN_PAGE = "https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx"
RBI_RAW_SCHEMA = ("CREATE TABLE IF NOT EXISTS rbi_raw (link TEXT PRIMARY KEY, feed TEXT, title TEXT, "
                  "pub_date TEXT, summary TEXT, kind TEXT, passed_gate INTEGER, gate_reasons TEXT, fetched_at INTEGER)")

def _bulletin_date(url: str) -> str:
    m = re.search(r"(\d{2})(\d{2})(\d{4})", url.rsplit("/", 1)[-1])
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    if not m: return ""
    d, mo, y = m.group(1), int(m.group(2)), m.group(3)
    return f"{d} {months[mo-1]} {y}" if 1 <= mo <= 12 else ""

def _bulletin_title(url: str, text: str) -> str:
    if "STATE" in url.upper():
        return "RBI Bulletin: State of the Economy"
    for line in text.splitlines():
        s = line.strip()
        if 15 <= len(s) <= 120 and any(c.isalpha() for c in s):
            return f"RBI Bulletin: {s}"
    return "RBI Bulletin article"

def fetch_bulletin(db_path: str, limit: int = 3) -> list:
    page = fetch_bytes(BULLETIN_PAGE).decode("utf-8", "ignore")
    urls = sorted(set(re.findall(r"https://rbidocs\.rbi\.org\.in/rdocs/Bulletin/PDFs/[^\"'\s<>]+\.PDF", page, re.I)))
    arts = [u for u in urls if not re.search(r"T_BULL|CONT|INDEX", u.rsplit("/", 1)[-1], re.I)]
    arts.sort(key=lambda u: (0 if "STATE" in u.upper() else 1, u))  # State of the Economy first
    con = sqlite3.connect(db_path); con.execute(RBI_RAW_SCHEMA)
    existing = {row[0] for row in con.execute("SELECT link FROM rbi_raw")}  # skip already-ingested → cheap re-runs
    ins = ("INSERT OR REPLACE INTO rbi_raw (link,feed,title,pub_date,summary,kind,passed_gate,gate_reasons,fetched_at) "
           "VALUES (?,?,?,?,?,?,?,?,?)")
    out = []
    for u in arts[:limit]:
        if u in existing:
            continue
        try:
            r = extract(pdf_bytes_from(u))
        except Exception as e:
            print(f"  ! extract failed {u.rsplit('/',1)[-1]}: {e}"); continue
        if len(r["text"]) < 800:
            continue
        title = _bulletin_title(u, r["text"])
        con.execute(ins, (u, "bulletin", title, _bulletin_date(u), r["text"][:60000], "bulletin", 1, '["bulletin"]', int(time.time())))
        out.append({"title": title, "pages": r["pages"], "chars": len(r["text"])})
    con.commit(); con.close()
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract text + tables from a source PDF (or .zip of PDFs).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    default_db = os.path.join(os.path.dirname(__file__), "..", "data", "filings.db")
    p_url = sub.add_parser("url"); p_url.add_argument("url")
    p_circ = sub.add_parser("circular"); p_circ.add_argument("circular_id"); p_circ.add_argument("--db", default=default_db)
    p_bull = sub.add_parser("bulletin"); p_bull.add_argument("--db", default=default_db); p_bull.add_argument("--limit", type=int, default=3)
    args = ap.parse_args()

    if args.cmd == "url":
        print(json.dumps(extract(pdf_bytes_from(args.url)), ensure_ascii=False, indent=2))
    elif args.cmd == "bulletin":
        print(json.dumps(fetch_bulletin(args.db, args.limit), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(extract_for_circular(args.circular_id, args.db), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
