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

# Run a command on a host: locally when it is THIS machine (deploy.sh is run
# from NightFuryX, which has no ssh key to itself), else over ssh.
LOCAL_IPS=" $(hostname -I 2>/dev/null) "
on() { # ip, command (stdin passes through)
  if [[ "$LOCAL_IPS" == *" $1 "* ]]; then
    bash -c "$2"
  else
    ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "nightfury@$1" "$2"
  fi
}

for ip in "${HOSTS[@]}"; do
  echo "=== $ip ==="
  on "$ip" \
    'cat > /home/nightfury/ask-fleet-boot.sh && chmod +x /home/nightfury/ask-fleet-boot.sh' \
    < ask-fleet-boot.sh
  on "$ip" \
    'sudo tee /etc/systemd/system/ask-fleet-boot.service >/dev/null \
       && sudo systemctl daemon-reload \
       && sudo systemctl enable ask-fleet-boot.service' \
    < ask-fleet-boot.service >/dev/null
  echo "  script + unit deployed, service enabled"
  # MiniNightFury has no Ask worktree (the old ask-* checkouts there were
  # deleted 2026-09-23), so the jobs it runs for the public searxng/degoog
  # stacks run from a synced copy in ~/fleet-boot instead:
  #   cron:  0 5 * * * /home/nightfury/fleet-boot/rotate-daily.sh public-searxng degoog
  #   timer: fleet-update-public-search.timer (weekly image update + crawl4ai check)
  if [ "$ip" = 192.168.50.231 ]; then
    MINI_FILES=(rotate-daily.sh rotate-mullvad.sh update-public-search.sh update-images.sh
                reclaim-space.sh check-crawl4ai-version.sh
                fleet-update-public-search.service fleet-update-public-search.timer)
    tar -cf - "${MINI_FILES[@]}" | on "$ip" \
      'mkdir -p /home/nightfury/fleet-boot && tar -xf - -C /home/nightfury/fleet-boot \
         && chmod +x /home/nightfury/fleet-boot/*.sh \
         && sudo cp /home/nightfury/fleet-boot/fleet-update-public-search.{service,timer} /etc/systemd/system/ \
         && sudo systemctl daemon-reload && sudo systemctl enable --now fleet-update-public-search.timer >/dev/null 2>&1'
    echo "  rotation + weekly public-search update scripts synced to ~/fleet-boot, timer enabled"
  fi
  if [ "${1:-}" = "run" ]; then
    on "$ip" \
      'sudo systemctl start ask-fleet-boot.service; journalctl -u ask-fleet-boot.service --no-pager -n 10 -o cat' \
      | sed 's/^/  /'
  fi
done
echo "done."
