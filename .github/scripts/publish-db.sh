#!/usr/bin/env bash
set -euo pipefail

repo="${REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$repo" ]]; then
  echo "[db] REPO or GITHUB_REPOSITORY is required" >&2
  exit 1
fi

if [[ ! -f data/filings.db ]]; then
  echo "[db] data/filings.db is missing; cannot publish" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cp data/filings.db "$tmpdir/filings.db"
gzip -f "$tmpdir/filings.db"

if ! gh release view filings-db-latest -R "$repo" >/dev/null 2>&1; then
  gh release create filings-db-latest -R "$repo" \
    --title "Latest filings DB" \
    --notes "Mutable SQLite seed used by Tipsheet GitHub Actions."
fi

gh release upload filings-db-latest "$tmpdir/filings.db.gz" --clobber -R "$repo"
echo "[db] published filings-db-latest release asset"
