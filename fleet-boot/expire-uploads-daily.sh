#!/usr/bin/env bash
# Unattended daily upload-TTL sweep for every Ask app stack on this host.
#
# The app exposes POST /api/maintenance/expire-uploads (checkIngestAuth bearer
# gate -> INGEST_API_TOKEN). expireIdleUploads() unlinks the bytes + .chunks.json
# sidecar of any upload whose chat has been idle past UPLOAD_TTL_DAYS (prod,
# staging and lab all set 14) and tombstones the row status='expired'. There is
# NO in-app scheduler, so this cron is what actually drives the sweep — it was a
# crontab entry on the old .231 host and did not survive the .231->.17 migration.
#
# Installed as: 15 4 * * *  (ahead of the 4:30 reclaim + 5:00 mullvad rotate).
# The token is read from the (gitignored) ingestor .env at runtime so it is
# never hardcoded in the crontab. Same token across all three envs.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

TOKEN="$(grep -oP '^INGEST_API_TOKEN=\K.*' /home/nightfury/selfhosted/ingestor/.env 2>/dev/null)"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/fleet-boot"
LOG="$LOG_DIR/expire-uploads-daily.log"
mkdir -p "$LOG_DIR"

{
  echo "===== $(date -Is) expire-uploads ====="
  if [[ -z "${TOKEN}" ]]; then
    echo "  no INGEST_API_TOKEN in ingestor/.env — skipping"
  else
    # prod 3738, staging 3739, lab 3742 — each app sweeps its own DB.
    for port in 3738 3739 3742; do
      body="$(mktemp)"
      code=$(curl -s -o "$body" -w '%{http_code}' --max-time 90 \
        -X POST -H "Authorization: Bearer ${TOKEN}" \
        "http://localhost:${port}/api/maintenance/expire-uploads" 2>/dev/null)
      echo "  :${port} -> ${code} $(cat "$body" 2>/dev/null)"
      rm -f "$body"
    done
  fi
} >>"$LOG" 2>&1

# Bound the log so an unattended job can never fill the disk.
if [[ -f "$LOG" ]]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi
