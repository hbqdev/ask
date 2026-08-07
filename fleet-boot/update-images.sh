#!/usr/bin/env bash
# Pull newer images for every stack we run, recreate the containers, then
# reclaim the space the old layers left behind.
#
# DOES UPDATING AN IMAGE LOSE OUR SETTINGS?  No.
#
# An image update replaces the container's own filesystem layers. Anything on a
# bind mount or a named volume lives OUTSIDE those layers and is untouched.
# Everything we configure is on one or the other:
#
#   bind mounts (files in git / on disk — always survive)
#     ask/searxng-settings.yml                -> prod ask searxng  /etc/searxng/settings.yml
#     ask/searxng-settings.admin-feature.yml  -> staging  "        /etc/searxng/settings.yml
#     ask/searxng-limiter.toml                -> both ask searxng instances
#     searxng/settings.yml                    -> public searxng
#     degoog/data                             -> degoog plugin + server settings
#     degoog/valkey-data                      -> degoog cache
#
#   named volumes (survive recreate; only `docker compose down -v` removes them)
#     ask-searxng-data, ask-searxng-data-admin-feature, searxng_searxng-valkey-data
#     postgres + redis data volumes
#
# The only things discarded are ANONYMOUS volumes (/etc/searxng, /var/cache/
# searxng), which hold generated config and cache that the image regenerates on
# boot. Nothing we authored lives there.
#
# The VPN overlays matter here: without them a stack comes back on the
# residential IP, silently losing Google. Every invocation below passes them.
#
# Usage:
#   ./update-images.sh            # all stacks
#   ./update-images.sh degoog     # one stack by name
#   ./update-images.sh --dry-run  # show what would be pulled, change nothing

set -uo pipefail

ASK=/home/nightfury/selfhosted/ask
DEGOOG=/home/nightfury/selfhosted/degoog
PUBLIC_SEARXNG=/home/nightfury/selfhosted/searxng

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=true; shift; }
ONLY="${1:-all}"

# name | dir | project | compose file args
STACKS=(
  "ask-prod|$ASK|ask-stack|-f docker-compose.yaml -f docker-compose.vpn.yaml"
  "ask-staging|$ASK|ask-stack-admin-feature|-f docker-compose.yaml -f docker-compose.admin-feature.yaml -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml"
  "degoog|$DEGOOG|degoog|-f docker-compose.yaml -f docker-compose.vpn.yaml"
  "public-searxng|$PUBLIC_SEARXNG|searxng|-f docker-compose.yaml -f docker-compose.vpn.yaml"
)

# Endpoint to prove each stack still serves after the update. A pull that
# leaves a stack down is worse than not pulling at all.
declare -A HEALTH=(
  [ask-prod]="http://192.168.50.231:3738/ http://192.168.50.231:3741/"
  [ask-staging]="http://192.168.50.231:3739/ http://192.168.50.231:3740/"
  [degoog]="http://192.168.50.231:4444/ https://nogoog.hbqnexus.win/"
  [public-searxng]="http://192.168.50.231:8127/ https://search.hbqnexus.win/"
)

failed=()

for entry in "${STACKS[@]}"; do
  IFS='|' read -r name dir project files <<<"$entry"
  [[ "$ONLY" != "all" && "$ONLY" != "$name" ]] && continue

  echo
  echo "=============================================================="
  echo "  $name  ($project)"
  echo "=============================================================="

  cd "$dir" || { echo "  !! $dir missing"; failed+=("$name:nodir"); continue; }

  # --ignore-buildable: Ask's own image is built from source, not pulled.
  # Without this the pull errors out and takes the whole stack with it.
  if $DRY_RUN; then
    echo "  [dry-run] would pull:"
    docker compose $files -p "$project" config --images 2>/dev/null | sed 's/^/    /'
    continue
  fi

  echo "-- pulling"
  docker compose $files -p "$project" pull --ignore-buildable 2>&1 | grep -viE '^$' | sed 's/^/  /'

  echo "-- recreating"
  if ! docker compose $files -p "$project" up -d 2>&1 | tail -6 | sed 's/^/  /'; then
    failed+=("$name:up")
    continue
  fi

  echo "-- verifying"
  sleep 20
  for url in ${HEALTH[$name]}; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$url" 2>/dev/null)
    if [[ "$code" == "200" ]]; then
      printf '   ok   %-42s %s\n' "$url" "$code"
    else
      printf '   FAIL %-42s %s\n' "$url" "${code:-timeout}"
      failed+=("$name:$url")
    fi
  done

  # A stack behind a VPN that comes back on the residential IP still "works",
  # so a 200 alone does not prove the tunnel survived. Check it explicitly.
  gluetun="$(docker compose $files -p "$project" ps -q gluetun 2>/dev/null)"
  if [[ -n "$gluetun" ]]; then
    exit_ip=$(docker exec "$gluetun" wget -qO- --timeout=15 https://ipinfo.io/ip 2>/dev/null)
    if [[ "$exit_ip" == "73.162.193.80" || -z "$exit_ip" ]]; then
      echo "   FAIL tunnel not up — egress is '${exit_ip:-unknown}' (residential)"
      failed+=("$name:tunnel")
    else
      echo "   ok   tunnel egress $exit_ip"
    fi
  fi
done

if ! $DRY_RUN; then
  echo
  echo "-- reclaiming space"
  # Sibling script, resolved relative to this one rather than pinned to the
  # development worktree — see the note in rotate-daily.sh.
  bash "$(cd -- "$(dirname -- "$(readlink -f -- "$0")")" && pwd)/reclaim-space.sh" 2>&1 | tail -6 | sed 's/^/  /'
fi

echo
if $DRY_RUN; then
  echo "Dry run — nothing pulled, nothing recreated."
  exit 0
fi
if ((${#failed[@]})); then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "All stacks updated and verified."
