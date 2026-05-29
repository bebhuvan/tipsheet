# Shared helpers for the SQLite release-asset transport.
# Sourced by restore-db.sh and publish-db.sh. No shebang — not executed directly.
#
# These guards exist because the canonical DB is a single mutable release asset
# (`filings-db-latest`). A truncated download or a partial write must never be
# allowed to overwrite it. Until D1 becomes the source of truth, this is the
# safety net. All helpers are best-effort if `sqlite3` is unavailable, but the
# GitHub ubuntu-latest runners ship it.

MIN_DB_BYTES="${MIN_DB_BYTES:-1048576}"   # 1 MiB floor — a healthy DB is tens of MiB
MIN_ENRICHED_ROWS="${MIN_ENRICHED_ROWS:-1}"

_have_sqlite() { command -v sqlite3 >/dev/null 2>&1; }

# file size in bytes, portable across GNU/BSD stat
_db_bytes() { wc -c < "$1" | tr -d '[:space:]'; }

# Echo the enriched-row count, or empty string if it can't be determined.
db_enriched_count() {
  local path="$1"
  _have_sqlite || { echo ""; return 0; }
  sqlite3 "$path" "SELECT COUNT(*) FROM filings_enriched;" 2>/dev/null || echo ""
}

# Fail (return 1) if the DB looks corrupt, empty, or truncated.
db_sanity_check() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "[db] sanity: $path does not exist" >&2; return 1
  fi
  local bytes; bytes="$(_db_bytes "$path")"
  if [[ "${bytes:-0}" -lt "$MIN_DB_BYTES" ]]; then
    echo "[db] sanity: $path is only ${bytes} bytes (< ${MIN_DB_BYTES} floor) — refusing" >&2
    return 1
  fi
  if _have_sqlite; then
    local integ; integ="$(sqlite3 "$path" 'PRAGMA integrity_check;' 2>/dev/null | head -1)"
    if [[ "$integ" != "ok" ]]; then
      echo "[db] sanity: integrity_check returned '${integ:-<error>}' — refusing" >&2
      return 1
    fi
    local rows; rows="$(db_enriched_count "$path")"
    if [[ -n "$rows" && "$rows" -lt "$MIN_ENRICHED_ROWS" ]]; then
      echo "[db] sanity: only ${rows} enriched rows (< ${MIN_ENRICHED_ROWS} floor) — refusing" >&2
      return 1
    fi
    echo "[db] sanity: ok (${bytes} bytes, ${rows:-?} enriched rows, integrity ok)"
  else
    echo "[db] sanity: ok (${bytes} bytes; sqlite3 unavailable, skipped integrity/row checks)" >&2
  fi
  return 0
}
