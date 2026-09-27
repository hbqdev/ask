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
#     ask-flow/searxng-settings.yml           -> lab      "        /etc/searxng/settings.yml
#     <worktree>/searxng-limiter.toml         -> every ask searxng instance
#     searxng/settings.yml                    -> public searxng
#     degoog/data                             -> degoog plugin + server settings
#     degoog/valkey-data                      -> degoog cache
#
#   named volumes (survive recreate; only `docker compose down -v` removes them)
#     ask-searxng-data, ask-searxng-data-admin-feature, ask-searxng-data-lab,
#     searxng_searxng-valkey-data
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

# PROD runs from the ask-prod worktree; STAGING runs from the ask worktree.
# These MUST NOT be conflated: base docker-compose.yaml is `name: ask-stack`
# (= prod), so recreating the ask-prod stack from $ASK (staging) would rebuild
# prod on STAGING's .env — wrong DATABASE_RESTRICTED_URL and OLLAMA_MODELS —
# while still reporting a green :3738 health check. Same class as the
# model-manager mis-wiring fixed 2026-08-09.
ASK_PROD=/home/nightfury/selfhosted/ask-prod
ASK=/home/nightfury/selfhosted/ask
# LAB runs from its own ask-flow worktree (same rule: never recreate a stack
# from another stack's worktree — compose reads that worktree's .env). Lab is
# included so its sidecars (postgres/redis/searxng/gluetun/tts) track prod's
# instead of silently drifting; experiments there should run on the same
# sidecar versions they'll be ported onto.
ASK_LAB=/home/nightfury/selfhosted/ask-flow
DEGOOG=/home/nightfury/selfhosted/degoog
PUBLIC_SEARXNG=/home/nightfury/selfhosted/searxng

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=true; shift; }
ONLY="${1:-all}"

# name | dir | project | compose file args
STACKS=(
  "ask-prod|$ASK_PROD|ask-stack|-f docker-compose.yaml -f docker-compose.vpn.yaml"
  "ask-staging|$ASK|ask-stack-admin-feature|-f docker-compose.yaml -f docker-compose.admin-feature.yaml -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml"
  "ask-lab|$ASK_LAB|ask-stack-lab|-f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml"
  "degoog|$DEGOOG|degoog|-f docker-compose.yaml -f docker-compose.vpn.yaml"
  "public-searxng|$PUBLIC_SEARXNG|searxng|-f docker-compose.yaml -f docker-compose.vpn.yaml"
)

# Endpoint to prove each stack still serves after the update. A pull that
# leaves a stack down is worse than not pulling at all.
declare -A HEALTH=(
  [ask-prod]="http://localhost:3738/ http://localhost:3741/"
  [ask-staging]="http://localhost:3739/ http://localhost:3740/"
  [ask-lab]="http://localhost:3742/ http://localhost:3743/"
  [degoog]="http://192.168.50.231:4444/ https://nogoog.hbqnexus.win/"
  [public-searxng]="http://192.168.50.231:8127/ https://search.hbqnexus.win/"
)

failed=()

# ---------------------------------------------------------------------------
# Ask app restart after sidecar recreates (incident 2026-09-27).
#
# `up -d` recreates any sidecar whose image changed (redis, postgres, searxng,
# gluetun) but leaves the running `ask` app alone. The app holds long-lived
# connections to those sidecars; on 2026-09-27 a recreated redis left the
# app's module-level Redis clients wedged, and every balanced/quality first
# search hung for 300s while the homepage kept answering 200 — so the old
# homepage-only check reported "verified". Two fixes live here:
#
#   1. If any sidecar container changed (new id or new start time) and the
#      app itself was not recreated, `docker restart` the app. restart keeps
#      the container and its network attachments (never recreate here: a
#      recreate is what can strand prod off ask-stack_default).
#   2. Verify the SEARCH path's Redis dependency, not just the homepage: the
#      token-gated GET /api/advanced-search probe PINGs Redis through the
#      route's own client and fires no web search. It runs inside the app
#      container so the internal token never leaves it.
# ---------------------------------------------------------------------------

# "<service> <container-id> <started-at>" for every running non-app container.
sidecar_state() { # <files> <project>
  docker compose $1 -p "$2" ps -q 2>/dev/null |
    xargs -r docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} {{.Id}} {{.State.StartedAt}}' 2>/dev/null |
    grep -v '^ask ' | sort
}

# The stack's app container id, or empty for non-Ask stacks (degoog/searxng).
app_container() { # <files> <project>
  docker compose $1 -p "$2" ps -q ask 2>/dev/null | head -1
}

app_started() { # <container>
  docker inspect -f '{{.Id}} {{.State.StartedAt}}' "$1" 2>/dev/null
}

# Wait until the app reports healthy (its healthcheck: 30s interval).
wait_app_healthy() { # <container> <max-seconds>
  local i
  for i in $(seq 1 "$2"); do
    [[ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null)" == healthy ]] && return 0
    sleep 1
  done
  return 1
}

# Redis probe through the advanced-search route (see app/api/advanced-search/
# route.ts GET). Prints "<status> <body>"; 405 = an app build that predates it.
PROBE_JS="const t=setTimeout(()=>{console.log('000 probe timed out');process.exit(0)},15000);fetch('http://127.0.0.1:3000/api/advanced-search',{headers:{authorization:'Bearer '+(process.env.INGEST_API_TOKEN||'')}}).then(async r=>{console.log(r.status+' '+(await r.text()).slice(0,200));process.exit(0)}).catch(e=>{console.log('000 '+e.message);process.exit(0)})"
search_redis_probe() { # <container>
  timeout 30 docker exec "$1" node -e "$PROBE_JS" 2>/dev/null || echo "000 docker exec failed"
}

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

  app="$(app_container "$files" "$project")"
  sidecars_before="$(sidecar_state "$files" "$project")"
  app_before="$( [[ -n "$app" ]] && app_started "$app")"

  echo "-- recreating"
  if ! docker compose $files -p "$project" up -d 2>&1 | tail -6 | sed 's/^/  /'; then
    failed+=("$name:up")
    continue
  fi

  # An Ask stack whose sidecars changed under a running app: restart the app
  # so it reconnects to them (see the note above the loop).
  app="$(app_container "$files" "$project")"
  if [[ -n "$app" ]]; then
    app_name="$(docker inspect -f '{{.Name}}' "$app" 2>/dev/null | sed 's#^/##')"
    if [[ "$(sidecar_state "$files" "$project")" != "$sidecars_before" ]]; then
      if [[ "$(app_started "$app")" != "$app_before" ]]; then
        echo "-- sidecars changed; $app_name was itself (re)started by up -d — no restart needed"
      else
        echo "-- sidecars changed under the running app; restarting $app_name"
        docker restart "$app" >/dev/null 2>&1 || failed+=("$name:app-restart")
        if wait_app_healthy "$app" 180; then
          echo "   ok   $app_name healthy after restart"
        else
          echo "   FAIL $app_name not healthy 180s after restart"
          failed+=("$name:app-health")
        fi
      fi
    else
      echo "-- no sidecar changed; $app_name left running"
    fi
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

  # The homepage answering 200 does not prove search works (2026-09-27: it
  # did, while every first search hung on a wedged Redis client). Probe the
  # search route's Redis path from inside the app; retried briefly because
  # the route's client connects lazily on first use.
  if [[ -n "$app" ]]; then
    probe=""
    for attempt in 1 2 3; do
      probe="$(search_redis_probe "$app")"
      [[ "$probe" == 200* || "$probe" == 405* ]] && break
      sleep 5
    done
    case "$probe" in
      200*) printf '   ok   %-42s %s\n' "search redis probe" "$probe" ;;
      405*) printf '   WARN %-42s %s\n' "search redis probe" "app build predates the probe (405) — not verified" ;;
      *)
        printf '   FAIL %-42s %s\n' "search redis probe" "$probe"
        failed+=("$name:search-redis")
        ;;
    esac
  fi

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
