#!/usr/bin/env bash
set -euo pipefail

repo="${REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$repo" ]]; then
  echo "[db] REPO or GITHUB_REPOSITORY is required" >&2
  exit 1
fi

mkdir -p data
rm -f filings.db filings.db.gz

echo "[db] restoring latest filings DB"
if gh release download filings-db-latest --pattern 'filings.db.gz' --clobber -R "$repo"; then
  gunzip -f filings.db.gz
  mv -f filings.db data/filings.db
  echo "[db] restored from filings-db-latest release"
elif gh release download --pattern 'filings.db.gz' --clobber -R "$repo"; then
  gunzip -f filings.db.gz
  mv -f filings.db data/filings.db
  echo "[db] restored from repository release fallback"
elif [[ -f data/filings.db ]]; then
  echo "[db] using existing data/filings.db"
else
  echo "[db] no filings DB found in releases or workspace" >&2
  exit 1
fi
