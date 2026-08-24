#!/usr/bin/env bash
# Ask fleet boot hardening — runs once at boot via the ask-fleet-boot.service
# systemd oneshot. Host-aware (branches on hostname).
#
# Why this exists: on the WSL2 GPU boxes a reboot/Docker restart leaves two
# things broken that `restart: unless-stopped` cannot recover from on its own:
#   1. A compose container pinned to a Docker network whose ID no longer exists
#      (WSL/daemon recreates networks with fresh IDs) -> container won't start.
#   2. Ollama comes back with no model resident (OLLAMA_KEEP_ALIVE=-1 only pins
#      a model AFTER its first load; it does not preload on boot), so the first
#      real request pays a cold load.
# This script reconciles the compose services onto fresh networks (only
# recreating when actually broken, so a healthy service is never reloaded) and
# warms the GPU-resident model.
set -u

log() { echo "[ask-fleet-boot] $(date '+%H:%M:%S') $*"; }

OLLAMA="http://localhost:11434"

# Wait for the Docker daemon to answer before reconciling anything. On the WSL2
# / Docker Desktop app host this systemd oneshot can fire before Docker
# Desktop's engine (and /dev/net/tun for the gluetun VPN sidecars) is ready.
wait_docker() {
  local i
  for i in $(seq 1 60); do
    docker info >/dev/null 2>&1 && { log "docker daemon ready"; return 0; }
    sleep 2
  done
  log "docker daemon NOT ready after 120s — proceeding anyway"
  return 1
}

# Bring a compose project up; if its container still isn't running afterward
# (stale network, etc.), recreate it on a fresh network. Recreates ONLY when
# broken, so a healthy container is never needlessly reloaded.
reconcile() {
  local dir="$1" name="$2"
  [ -d "$dir" ] || { log "skip $name (missing $dir)"; return 0; }
  ( cd "$dir" && docker compose up -d ) >/dev/null 2>&1
  sleep 3
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]; then
    log "$name not running after 'up' — recreating on a fresh network"
    ( cd "$dir" && docker compose down && docker compose up -d ) >/dev/null 2>&1
    sleep 3
  fi
  log "$name -> $(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
}

# True once a container reports healthy (or, if it has no healthcheck, running).
# Polls up to $2 seconds. A container WITH a healthcheck must reach 'healthy' —
# 'starting'/'unhealthy'/'restarting' don't count, which is what catches the
# boot-time strand where the app crash-loops (migration can't reach its DB).
app_healthy() {
  local c="$1" max="$2" i
  for i in $(seq 1 "$max"); do
    case "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null)" in
      healthy | running) return 0 ;;
    esac
    sleep 1
  done
  return 1
}

# Reconcile one multi-compose-file APP stack (prod/staging/lab on the app host).
# Unlike reconcile() (single default compose file, GPU boxes), this passes the
# stack's real -f set and gates on HEALTH, escalating only when the app doesn't
# come up healthy:
#   1. `up -d`  — start anything missing (a healthy stack ends here, untouched).
#   2. not healthy -> `up -d --force-recreate <service>` — reattaches the app to
#      its networks; fixes the reboot strand where it rejoined only shared-infra
#      and crash-looped on ENOTFOUND (the exact fix applied by hand 2026-08-17).
#   3. still not healthy -> `down && up -d` — full network reset (last resort).
# Usage: reconcile_app_stack <dir> <container> <service> <-f file ...>
reconcile_app_stack() {
  local dir="$1" container="$2" service="$3"
  shift 3
  local files=("$@")
  [ -d "$dir" ] || {
    log "skip $container (missing $dir)"
    return 0
  }
  ( cd "$dir" && docker compose "${files[@]}" up -d ) >/dev/null 2>&1
  if app_healthy "$container" 180; then
    log "$container -> healthy"
    return 0
  fi
  log "$container not healthy after 'up' — force-recreating $service (network reattach)"
  ( cd "$dir" && docker compose "${files[@]}" up -d --force-recreate "$service" ) >/dev/null 2>&1
  if app_healthy "$container" 180; then
    log "$container -> healthy after force-recreate"
    return 0
  fi
  log "$container still unhealthy — full down/up (network reset)"
  ( cd "$dir" && docker compose "${files[@]}" down && docker compose "${files[@]}" up -d ) >/dev/null 2>&1
  if app_healthy "$container" 240; then
    log "$container -> healthy after down/up"
  else
    log "$container -> STILL UNHEALTHY ($(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)) — needs a human"
  fi
}

# Wait for Ollama to answer, then load a model resident (keep_alive=-1) so the
# GPU isn't cold on the first request.
warm() {
  local model="$1"
  local i
  for i in $(seq 1 30); do
    curl -sf -o /dev/null --max-time 3 "$OLLAMA/api/tags" && break
    sleep 2
  done
  log "warming $model"
  if curl -s --max-time 180 "$OLLAMA/api/generate" \
       -d "{\"model\":\"$model\",\"prompt\":\"warmup\",\"stream\":false,\"keep_alive\":-1}" \
       -o /dev/null; then
    log "$model warm ok"
  else
    log "$model warm FAILED"
  fi
}

# Ensure the Whisper STT model is installed for the ask-whisper service.
# speaches does NOT auto-download models on a transcription request, and its
# PRELOAD_MODELS env is ignored by the pinned image — the model must be
# installed via the API. Idempotent: a fast no-op when the model is already
# cached in the hf-cache volume (the common case after a reboot); on a fresh
# volume it downloads (~1.5GB), which is why the timeout is generous.
warm_whisper() {
  local url="http://localhost:8788"
  local model="Systran/faster-distil-whisper-large-v3"
  local i
  for i in $(seq 1 30); do
    curl -sf -o /dev/null --max-time 3 "$url/health" && break
    sleep 2
  done
  log "ensuring whisper model $model"
  if curl -s --max-time 600 -X POST "$url/v1/models/$model" -o /dev/null; then
    log "whisper model ensured"
  else
    log "whisper model ensure FAILED"
  fi
}

HOST="$(hostname)"
log "starting on $HOST"
wait_docker
case "$HOST" in
  NightFuryX)
    reconcile /home/nightfury/selfhosted/reranker-qwen reranker-qwen
    reconcile /home/nightfury/selfhosted/ingestor      ingestor
    reconcile /home/nightfury/selfhosted/whisper       ask-whisper
    warm qwen3-vl:4b
    warm_whisper
    # The Ask app tier moved here in the 2026-08-23 migration. On a cold boot
    # the gluetun VPN sidecars lose the /dev/net/tun race and exit 127, taking
    # searxng (network_mode: service:gluetun) with them; restart:unless-stopped
    # gives up after its backoff, leaving the apps up but search dead. Let
    # Docker Desktop networking settle, then reconcile all three stacks
    # (reconcile_app_stack's first move is a full `up -d`, which restarts the
    # dead sidecars) plus model-manager.
    sleep 15
    reconcile_app_stack /home/nightfury/selfhosted/ask-prod ask ask \
      -f docker-compose.yaml -f docker-compose.vpn.yaml
    reconcile_app_stack /home/nightfury/selfhosted/ask ask-admin-feature ask \
      -f docker-compose.yaml -f docker-compose.admin-feature.yaml \
      -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml
    reconcile_app_stack /home/nightfury/selfhosted/ask-flow ask-lab ask \
      -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml
    reconcile /home/nightfury/selfhosted/ask/selfhosted/model-manager model-manager
    ;;
  NightFuryS)
    reconcile /home/nightfury/selfhosted/embedder embedder
    # embedder preloads its own model on start (compose start_period 300s)
    ;;
  Serenity)
    warm granite4.1:8b
    ;;
  MiniNightFury)
    # The Ask app stacks MOVED to NightFuryX (2026-08-23 migration) and are
    # reconciled there now. What remains here — crawl4ai, public searxng/degoog
    # — carries its own restart: unless-stopped; cloudflared is a Windows
    # service. crawl4ai is the one Ask dependency worth nudging on boot.
    reconcile /home/nightfury/selfhosted/crawl4ai crawl4ai
    ;;
  *)
    log "unknown host '$HOST' — nothing to do"
    ;;
esac
log "done"
exit 0
