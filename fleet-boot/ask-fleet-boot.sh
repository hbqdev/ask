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
case "$HOST" in
  NightFuryX)
    reconcile /home/nightfury/selfhosted/reranker-qwen reranker-qwen
    reconcile /home/nightfury/selfhosted/ingestor      ingestor
    reconcile /home/nightfury/selfhosted/whisper       ask-whisper
    warm qwen3-vl:4b
    warm_whisper
    ;;
  NightFuryS)
    reconcile /home/nightfury/selfhosted/embedder embedder
    # embedder preloads its own model on start (compose start_period 300s)
    ;;
  Serenity)
    warm granite4.1:8b
    ;;
  *)
    log "unknown host '$HOST' — nothing to do"
    ;;
esac
log "done"
exit 0
