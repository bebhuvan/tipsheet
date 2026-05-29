#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=db-lib.sh
source "$here/db-lib.sh"

repo="${REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$repo" ]]; then
  echo "[db] REPO or GITHUB_REPOSITORY is required" >&2
  exit 1
fi

if [[ ! -f data/filings.db ]]; then
  echo "[db] data/filings.db is missing; cannot publish" >&2
  exit 1
fi

# Never overwrite the canonical asset with a corrupt/truncated DB.
if ! db_sanity_check data/filings.db; then
  echo "[db] local DB failed sanity check — refusing to publish" >&2
  exit 1
fi

new_rows="$(db_enriched_count data/filings.db)"

# Cheap regression guard: a tiny metadata sidecar records the last published
# enriched-row count. If this run would publish a DB with a large drop (>10%)
# in enriched rows, refuse unless FORCE_PUBLISH=1 — this catches a stale or
# half-restored DB clobbering good state. Downloading the sidecar is a few
# bytes, not the 48 MB DB.
if [[ -n "$new_rows" && "${FORCE_PUBLISH:-0}" != "1" ]]; then
  prev_rows=""
  if gh release download filings-db-latest --pattern 'filings.meta.json' --clobber -R "$repo" -O /tmp/filings.meta.json 2>/dev/null; then
    prev_rows="$(grep -o '"enriched_count"[[:space:]]*:[[:space:]]*[0-9]*' /tmp/filings.meta.json | grep -o '[0-9]*' | head -1 || true)"
  fi
  if [[ -n "$prev_rows" && "$prev_rows" -gt 0 ]]; then
    floor=$(( prev_rows * 90 / 100 ))
    if [[ "$new_rows" -lt "$floor" ]]; then
      echo "[db] REFUSING: new enriched_count=$new_rows is >10% below last published=$prev_rows (floor=$floor)." >&2
      echo "[db] If this drop is intentional, re-run with FORCE_PUBLISH=1." >&2
      exit 1
    fi
  fi
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cp data/filings.db "$tmpdir/filings.db"
gzip -f "$tmpdir/filings.db"

# Build the metadata sidecar (cheap to fetch on the next publish's guard).
sha="$( (sha256sum "$tmpdir/filings.db.gz" 2>/dev/null || shasum -a 256 "$tmpdir/filings.db.gz") | awk '{print $1}')"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$tmpdir/filings.meta.json" <<EOF
{"enriched_count": ${new_rows:-null}, "sha256": "${sha}", "published_at": "${stamp}", "run_id": "${GITHUB_RUN_ID:-local}", "workflow": "${GITHUB_WORKFLOW:-local}"}
EOF

if ! gh release view filings-db-latest -R "$repo" >/dev/null 2>&1; then
  gh release create filings-db-latest -R "$repo" \
    --title "Latest filings DB" \
    --notes "Mutable SQLite seed used by Tipsheet GitHub Actions."
fi

gh release upload filings-db-latest "$tmpdir/filings.db.gz" "$tmpdir/filings.meta.json" --clobber -R "$repo"
echo "[db] published filings-db-latest (enriched_count=${new_rows:-?})"

# Daily restore point: first publish of the (UTC) day creates a dated backup
# asset; later publishes that day leave it untouched (|| true). Cheap insurance
# against a bad clobber — restore with: gh release download filings-db-latest --pattern 'filings-YYYYMMDD.db.gz'
day="$(date -u +%Y%m%d)"
backup="filings-${day}.db.gz"
if ! gh release view filings-db-latest -R "$repo" --json assets --jq '.assets[].name' 2>/dev/null | grep -qx "$backup"; then
  cp "$tmpdir/filings.db.gz" "$tmpdir/$backup"
  gh release upload filings-db-latest "$tmpdir/$backup" -R "$repo" 2>/dev/null \
    && echo "[db] wrote daily backup $backup" \
    || echo "[db] daily backup $backup already exists or upload skipped"
fi
