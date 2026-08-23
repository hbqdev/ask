#!/usr/bin/env bash
# Weekly auto-update for the PUBLIC search stacks: public SearXNG
# (search.hbqnexus.win) + degoog (nogoog.hbqnexus.win / :4444). Both run
# upstream :latest images, so "update" = pull newer + recreate.
#
# Driven by fleet-update-public-search.timer -> .service (runs as nightfury,
# Sundays). Each update-images.sh call pulls upstream :latest, recreates via
# the gluetun VPN overlay (critical — without it the stack returns on the
# residential IP and loses Google), health-checks the live URL, and re-verifies
# the gluetun tunnel. We run BOTH stacks even if one fails (no `set -e`), and
# append a timestamped record to the log.
#
#   ./update-public-search.sh            # pull + recreate both public stacks
#   ./update-public-search.sh --dry-run  # show what would pull, change nothing
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/home/nightfury/selfhosted/logs/update-public-search.log
mkdir -p "$(dirname "$LOG")"

DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

{
  echo "===== $(date '+%F %T %Z') — weekly public-search image update ${DRY} ====="
  "$HERE/update-images.sh" $DRY degoog
  "$HERE/update-images.sh" $DRY public-searxng
  echo "===== done $(date '+%F %T %Z') ====="
  echo
} 2>&1 | tee -a "$LOG"
