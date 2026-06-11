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
CONTENT_CONTRACT_ARTICLE_LIMIT="${CONTENT_CONTRACT_ARTICLE_LIMIT:-200}"

_have_sqlite() { command -v sqlite3 >/dev/null 2>&1; }

# file size in bytes, portable across GNU/BSD stat
_db_bytes() { wc -c < "$1" | tr -d '[:space:]'; }

# Echo the enriched-row count, or empty string if it can't be determined.
db_enriched_count() {
  local path="$1"
  _have_sqlite || { echo ""; return 0; }
  sqlite3 "$path" "SELECT COUNT(*) FROM filings_enriched;" 2>/dev/null || echo ""
}

db_content_contract_check() {
  local path="$1"
  _have_sqlite || { echo "[db] content: sqlite3 unavailable, skipped content contract" >&2; return 0; }

  local failures
  failures="$(sqlite3 "$path" "
    WITH latest_articles AS (
      SELECT r.record_id, r.symbol, r.company,
             e.headline, e.dek, e.the_number_value, e.the_number_label
      FROM filings_raw r
      JOIN filings_enriched e ON e.record_id = r.record_id
      WHERE e.validation_ok = 1
      ORDER BY r.created_on DESC
      LIMIT ${CONTENT_CONTRACT_ARTICLE_LIMIT}
    )
    SELECT 'article ' || record_id || ': missing symbol' FROM latest_articles WHERE symbol IS NULL OR trim(symbol) = ''
    UNION ALL
    SELECT 'article ' || record_id || ': missing company' FROM latest_articles WHERE company IS NULL OR trim(company) = ''
    UNION ALL
    SELECT 'article ' || record_id || ': missing headline' FROM latest_articles WHERE headline IS NULL OR trim(headline) = ''
    UNION ALL
    SELECT 'article ' || record_id || ': missing dek' FROM latest_articles WHERE dek IS NULL OR trim(dek) = ''
    UNION ALL
    SELECT 'article ' || record_id || ': missing the_number_value' FROM latest_articles WHERE the_number_value IS NULL OR trim(the_number_value) = ''
    UNION ALL
    SELECT 'article ' || record_id || ': missing the_number_label' FROM latest_articles WHERE the_number_label IS NULL OR trim(the_number_label) = ''
    LIMIT 20;
  " 2>/dev/null || true)"

  if [[ -n "$failures" ]]; then
    echo "[db] content contract failed:" >&2
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "[db]   - $line" >&2
    done <<< "$failures"
    return 1
  fi

  echo "[db] content: ok (latest ${CONTENT_CONTRACT_ARTICLE_LIMIT} validated articles)"
  return 0
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
    if ! db_content_contract_check "$path"; then
      echo "[db] sanity: content contract failed — refusing" >&2
      return 1
    fi
    echo "[db] sanity: ok (${bytes} bytes, ${rows:-?} enriched rows, integrity ok)"
  else
    echo "[db] sanity: ok (${bytes} bytes; sqlite3 unavailable, skipped integrity/row checks)" >&2
  fi
  return 0
}
