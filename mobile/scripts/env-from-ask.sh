#!/usr/bin/env bash
# Writes mobile/.env.local (git-ignored) for the app build, taking the
# Supabase URL and publishable key from Ask's root .env.
#
#   scripts/env-from-ask.sh [ask-api-url]    # default https://ask.hbqnexus.win
#
# Prints only the names of the variables it wrote, never their values.
# ASK_ENV_FILE / MOBILE_ENV_OUT override the input and output paths (tests).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="${ASK_ENV_FILE:-$here/../.env}"
out="${MOBILE_ENV_OUT:-$here/.env.local}"
api_url="${1:-https://ask.hbqnexus.win}"

if [ ! -r "$src" ]; then
  echo "env-from-ask: cannot read $src" >&2
  exit 1
fi

# Value of $1 in $src (last assignment wins), with `export` and one layer of
# surrounding quotes removed. Fails, naming only the variable, when unset.
read_var() {
  local name="$1" line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" "$src" | tail -n 1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  if [ -z "$value" ]; then
    echo "env-from-ask: $name is not set in $src" >&2
    return 1
  fi
  printf '%s' "$value"
}

supabase_url="$(read_var NEXT_PUBLIC_SUPABASE_URL)"
publishable_key="$(read_var NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"

umask 077
tmp="$(mktemp "${out}.XXXXXX")"
# Never leave the temp copy behind (it holds the key) if a write fails; after
# the mv it no longer exists and rm -f is a no-op.
trap 'rm -f "$tmp"' EXIT
{
  printf 'VITE_SUPABASE_URL=%s\n' "$supabase_url"
  printf 'VITE_SUPABASE_PUBLISHABLE_KEY=%s\n' "$publishable_key"
  printf 'VITE_ASK_API_URL=%s\n' "$api_url"
} > "$tmp"
mv "$tmp" "$out"

echo "Wrote ${out}: VITE_SUPABASE_URL VITE_SUPABASE_PUBLISHABLE_KEY VITE_ASK_API_URL"
