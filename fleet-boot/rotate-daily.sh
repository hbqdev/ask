#!/usr/bin/env bash
# Unattended daily Mullvad rotation for every gluetun-fronted stack.
#
# WHY DAILY, AND WHY NOT ON A SIGNAL: SearXNG's engine errors are not a reliable
# trigger. It logs per-engine CAPTCHA/suspension lines while the search as a
# whole still returns results — a rotation driven off those logs would fire
# constantly and pointlessly. Worse, rotate-mullvad.sh's own header warns that
# the same query pattern arriving from a rapid succession of IPs in one ASN is
# a STRONGER bot signal than steady traffic from one address. So: a fixed, slow
# cadence, deliberately not adaptive.
#
# --clear-health is not optional here. Ask suspends engines by NAME for 30
# minutes (lib/search/engine-health.ts), so without it brave/duckduckgo stay
# suspended on the fresh IP and the rotation buys nothing for the rest of the
# window. Those suspensions were evidence about the OLD address.
#
# Installed as: 0 5 * * *  (see `crontab -l`). 5am avoids the 4:15 upload sweep
# and the 4:30 docker-maintenance run already in the crontab.

set -uo pipefail

# cron gives a near-empty PATH; docker and flock both live in /usr/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Resolved relative to this script, not hardcoded to one worktree. These
# scripts exist in every worktree (ask, ask-prod, ask-flow); pinning the path
# to /selfhosted/ask meant a prod cron reached into the DEVELOPMENT tree, so a
# branch checkout there could silently change or remove what prod runs nightly.
SCRIPT_DIR="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)"
ROTATE="$SCRIPT_DIR/rotate-mullvad.sh"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-boot"
LOG="$LOG_DIR/rotate-daily.log"
LOCK=/tmp/fleet-boot-rotate.lock
MAX_LINES=2000

mkdir -p "$LOG_DIR"

# Logs live outside the repo on purpose: a log file inside fleet-boot/ would be
# one `git add -A` away from being committed.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Is) skipped — a rotation is already running" >>"$LOG"
  exit 0
fi

{
  echo "===== $(date -Is) rotate all ====="
  "$ROTATE" rotate all --clear-health
  echo "--- exit status: $? ---"
} >>"$LOG" 2>&1

# Bound the log so an unattended job can never fill the disk.
if [[ -f "$LOG" ]]; then
  tail -n "$MAX_LINES" "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
