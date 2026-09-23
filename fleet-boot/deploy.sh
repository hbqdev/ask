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

# NightFuryX, NightFuryS, Serenity, MiniNightFury. .231 must stay in this
# list: it was missing, so its copy went stale and resurrected the retired
# Ask stacks at the 2026-09-16 boot.
HOSTS=(192.168.50.17 192.168.50.160 192.168.50.171 192.168.50.231)

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
  # MiniNightFury has no current Ask worktree (its ask-* checkouts are the
  # retired stacks' leftovers), so its nightly Mullvad rotation for the public
  # searxng/degoog stacks runs from a synced copy in ~/fleet-boot instead:
  #   0 5 * * * /home/nightfury/fleet-boot/rotate-daily.sh public-searxng degoog
  if [ "$ip" = 192.168.50.231 ]; then
    tar -cf - rotate-daily.sh rotate-mullvad.sh | ssh -o ConnectTimeout=6 "nightfury@$ip" \
      'mkdir -p /home/nightfury/fleet-boot && tar -xf - -C /home/nightfury/fleet-boot \
         && chmod +x /home/nightfury/fleet-boot/rotate-daily.sh /home/nightfury/fleet-boot/rotate-mullvad.sh'
    echo "  rotate-daily.sh + rotate-mullvad.sh synced to ~/fleet-boot"
  fi
  if [ "${1:-}" = "run" ]; then
    ssh -o ConnectTimeout=10 "nightfury@$ip" \
      'sudo systemctl start ask-fleet-boot.service; journalctl -u ask-fleet-boot.service --no-pager -n 10 -o cat' \
      | sed 's/^/  /'
  fi
done
echo "done."
