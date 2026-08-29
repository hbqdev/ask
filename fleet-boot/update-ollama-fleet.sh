#!/usr/bin/env bash
# Weekly fleet-wide Ollama auto-update. Ollama is a native systemd service on
# every host (.17/.160/.171 WSL2, .231 native Linux), so each host's
# ~/update-ollama.sh runs the official installer (updates the binary + restarts
# the service) and re-pins its resident models. This driver runs that worker on
# .17 locally and on the rest over SSH (all keys authorized as of 2026-08-28).
# Scheduled from the .17 crontab (Sunday, offset from the app-stack update).
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LOG="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-boot/update-ollama.log"
mkdir -p "$(dirname "$LOG")"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=8"
REMOTES=(192.168.50.160 192.168.50.171 192.168.50.231)

{
  echo "===== $(date -Is) update-ollama-fleet ====="
  # .17 (local). Its ollama is the cloud proxy + vision host, so the restart is
  # a brief blip — run at the low-traffic scheduled hour.
  bash "$HOME/update-ollama.sh" 2>&1 || echo "  .17 (local): update FAILED"
  for h in "${REMOTES[@]}"; do
    $SSH "nightfury@$h" 'bash ~/update-ollama.sh' 2>&1 || echo "  $h: unreachable / update FAILED"
  done
} >> "$LOG" 2>&1

# Bound the log.
tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
