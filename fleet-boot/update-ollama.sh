#!/usr/bin/env bash
# Per-host worker: update the native Ollama (systemd service, /usr/local/bin) to
# the latest release ON THIS HOST, then re-pin whatever models were resident so
# the GPU isn't left cold after the restart. Driven fleet-wide by
# update-ollama-fleet.sh; safe to run by hand too. Needs passwordless sudo
# (install.sh writes /usr/local/bin + restarts the systemd unit).
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
API=http://localhost:11434

ver() { ollama --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }

before=$(ver)
# Models resident right now (to re-pin with keep_alive=-1 after the restart).
resident=$(curl -s --max-time 5 "$API/api/ps" 2>/dev/null \
  | python3 -c "import sys,json;print(' '.join(m['name'] for m in json.load(sys.stdin).get('models',[])))" 2>/dev/null)

# Official installer: detects the existing install, updates the binary, and
# restarts the ollama systemd service. Quiet unless it errors.
curl -fsSL https://ollama.com/install.sh | sh >/dev/null 2>&1

# Wait for the daemon to answer again after the restart.
for _ in $(seq 1 30); do curl -sf -o /dev/null --max-time 3 "$API/api/tags" && break; sleep 2; done
after=$(ver)

# Re-pin the previously-resident models (keep_alive=-1), one tiny generate each.
for m in $resident; do
  curl -s --max-time 120 "$API/api/generate" \
    -d "{\"model\":\"$m\",\"prompt\":\"warmup\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" \
    -o /dev/null 2>&1 || true
done

if [ "$before" = "$after" ]; then
  echo "$(hostname): ollama $after (already latest)${resident:+ | re-pinned: $resident}"
else
  echo "$(hostname): ollama $before -> $after${resident:+ | re-pinned: $resident}"
fi
