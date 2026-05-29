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

# A corrupt/truncated restore must fail the run BEFORE we ingest on top of it
# and republish garbage. This is the gate that previously did not exist.
if ! db_sanity_check data/filings.db; then
  echo "[db] restored DB failed sanity check — aborting so we do not build on a bad DB" >&2
  exit 1
fi
