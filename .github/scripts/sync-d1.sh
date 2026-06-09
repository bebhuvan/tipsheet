#!/usr/bin/env bash
set -euo pipefail

missing=()
for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN D1_DATABASE_ID; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} )); then
  echo "[d1-sync] missing required env: ${missing[*]}" >&2
  exit 1
fi

cd pipeline
read -r -a extra_args <<< "${D1_SYNC_ARGS:-}"
node --env-file=../.env.ci sync-to-d1.mjs "${extra_args[@]}"
