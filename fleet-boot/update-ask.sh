#!/usr/bin/env bash
# Weekly image update for the ASK app stacks (prod + staging) on NightFuryX.
#
# Sibling of update-public-search.sh, which handles the PUBLIC stacks (degoog +
# public-searxng) on MiniNightFury (.231). After the 2026-08 migration the ask
# app stacks live on NightFuryX (.17), so THIS wrapper runs here, driven by
# fleet-update-ask.timer (Sundays). The public timer stays on .231 — each host
# updates only the stacks it actually runs (update-images.sh does a LOCAL
# `docker compose pull && up -d`, so it must run where the containers are).
#
# Each update-images.sh call pulls the sidecar images (--ignore-buildable skips
# Ask's own image, which is built from source, not pulled), recreates via the
# gluetun VPN overlay, then health-checks the app + verifies the tunnel egress
# is the VPN and not the residential IP. So this only ever refreshes
# postgres/redis/searxng/gluetun/kokoro — never the app build.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/home/nightfury/selfhosted/logs/update-ask.log
mkdir -p "$(dirname "$LOG")"
DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"
{
  echo "===== $(date '+%F %T %Z') — weekly ask-stack image update ${DRY} ====="
  "$HERE/update-images.sh" $DRY ask-prod
  "$HERE/update-images.sh" $DRY ask-staging
  echo "===== done $(date '+%F %T %Z') ====="
  echo
} 2>&1 | tee -a "$LOG"
