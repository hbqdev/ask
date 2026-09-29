#!/usr/bin/env bash
# Deploy ask-fleet-boot.{sh,service} to the Ask GPU boxes. Re-run this after
# editing ask-fleet-boot.sh here.
#
# Enablement is decided per host by PLATFORM, not IP: on a WSL host the unit is
# left DISABLED. Docker Desktop cannot attach its WSL integration until systemd
# reports boot finished, so a unit in multi-user.target that waits for Docker
# deadlocks the boot (Serenity .171, 2026-09-29: "Bootup is not yet finished"
# for 8 min, Docker never came up). fleet-boot.timer (75 s after boot) still
# pulls ask-fleet-boot.service in via Wants=/After=, so it runs every boot —
# after boot finishes instead of holding it open. On bare metal (.231, a real
# docker.service) it is enabled as before.
# RULE: on a WSL host, nothing that waits for Docker may be enabled into
# multi-user.target.
#
#   ./deploy.sh          # push script + unit (enabled on bare metal only)
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
       && if [ "$(systemd-detect-virt --container 2>/dev/null)" = wsl ]; then
            # WSL: never on the boot path; fleet-boot.timer pulls it in after boot.
            sudo systemctl disable ask-fleet-boot.service >/dev/null 2>&1; echo "  script + unit deployed, left disabled (WSL)"
          else
            sudo systemctl enable ask-fleet-boot.service >/dev/null 2>&1;  echo "  script + unit deployed, enabled"
          fi' \
    < ask-fleet-boot.service
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
