#!/usr/bin/env bash
# Deploy ask-fleet-boot.{sh,service} to the Ask GPU boxes and enable the
# systemd oneshot. Re-run this after editing ask-fleet-boot.sh here.
#
#   ./deploy.sh          # push script + unit, enable on boot
#   ./deploy.sh run      # ...and also trigger it once now on each host
#
# Needs: ssh key access as nightfury@ to each host, passwordless sudo there.
set -euo pipefail
cd "$(dirname "$0")"

# NightFuryX, NightFuryS, Serenity
HOSTS=(192.168.50.17 192.168.50.160 192.168.50.171)

for ip in "${HOSTS[@]}"; do
  echo "=== $ip ==="
  ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new "nightfury@$ip" \
    'cat > /home/nightfury/ask-fleet-boot.sh && chmod +x /home/nightfury/ask-fleet-boot.sh' \
    < ask-fleet-boot.sh
  ssh -o ConnectTimeout=6 "nightfury@$ip" \
    'sudo tee /etc/systemd/system/ask-fleet-boot.service >/dev/null \
       && sudo systemctl daemon-reload \
       && sudo systemctl enable ask-fleet-boot.service' \
    < ask-fleet-boot.service >/dev/null
  echo "  script + unit deployed, service enabled"
  if [ "${1:-}" = "run" ]; then
    ssh -o ConnectTimeout=10 "nightfury@$ip" \
      'sudo systemctl start ask-fleet-boot.service; journalctl -u ask-fleet-boot.service --no-pager -n 10 -o cat' \
      | sed 's/^/  /'
  fi
done
echo "done."
