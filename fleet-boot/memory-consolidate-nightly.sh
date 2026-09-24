#!/usr/bin/env bash
# Nightly memory consolidation for the Ask app stacks on this host (.17).
#
# The app exposes POST /api/memory/consolidate (lib/auth/cron-auth.ts:
# requireCronSecret -> "Authorization: Bearer $MEMORY_CRON_SECRET", fails
# closed with 503 when the var is unset). consolidateAllActiveUsers() lists
# every user with memories (dbAdmin) and, per user, drops exact-duplicate
# confirmed memories and evicts over MEMORY_MAX_PER_USER (default 30). No LLM
# calls — a cheap DB sweep. There is NO in-app scheduler, so this cron is what
# drives it (same pattern as expire-uploads-daily.sh).
#
# Usage: memory-consolidate-nightly.sh <env>...   env = prod | staging | lab
# Crontab (.17):  45 3 * * *  .../fleet-boot/memory-consolidate-nightly.sh lab
#   (03:45 — quiet hours, ahead of the 04:15 upload sweep / 04:30 reclaim.)
#
# The secret is read at runtime from THAT env's (gitignored, 0600) .env and is
# never echoed, logged or placed on the command line (curl reads the header
# from stdin via -H @-).
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ROOT=/home/nightfury/selfhosted
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-boot"
LOG="$LOG_DIR/memory-consolidate.log"
mkdir -p "$LOG_DIR"

env_dir() {
  case "$1" in
    prod) echo "$ROOT/ask-prod" ;;
    staging) echo "$ROOT/ask" ;;
    lab) echo "$ROOT/ask-flow" ;;
    *) return 1 ;;
  esac
}
env_port() {
  case "$1" in
    prod) echo 3738 ;;
    staging) echo 3739 ;;
    lab) echo 3742 ;;
    *) return 1 ;;
  esac
}

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <prod|staging|lab>..." >&2
  exit 2
fi

{
  echo "===== $(date -Is) memory-consolidate ($*) ====="
  for env in "$@"; do
    dir="$(env_dir "$env")" || { echo "  $env: unknown env — skipping"; continue; }
    port="$(env_port "$env")"
    secret="$(grep -oP '^MEMORY_CRON_SECRET=\K.*' "$dir/.env" 2>/dev/null | tr -d '\r' | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
    if [[ -z "$secret" ]]; then
      echo "  $env: no MEMORY_CRON_SECRET in $dir/.env — skipping"
      continue
    fi
    body="$(mktemp)"
    code=$(printf 'Authorization: Bearer %s\n' "$secret" |
      curl -s -o "$body" -w '%{http_code}' --max-time 300 \
        -X POST -H @- "http://localhost:${port}/api/memory/consolidate" 2>/dev/null)
    echo "  $env :${port} -> ${code} $(head -c 500 "$body" 2>/dev/null)"
    rm -f "$body"
    unset secret
  done
} >>"$LOG" 2>&1

# Bound the log so an unattended job can never fill the disk.
if [[ -f "$LOG" ]]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
