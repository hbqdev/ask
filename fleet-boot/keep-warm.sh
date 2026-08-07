#!/usr/bin/env bash
# Ask GPU keep-warm.
#
# The classifier (granite, .171 P5000) and reranker (.17 2080 Ti) keep their
# models resident, but WSL2 does NOT allow clock-locking (nvidia-smi -lgc is
# "not supported"), so when idle the GPUs drop to power state P8 (~139-300 MHz,
# ~8% of max). The FIRST request after idle then runs at that crawl clock and
# ramps to P0 — which is the entire cold/warm latency gap (classify 7s cold vs
# 1.6s warm, recall 4.3s cold vs 1.4s warm).
#
# Measured: after one request the GPU holds P0 for 8s+. So a lightweight ping
# every ~8s keeps all three services at full clock, eliminating the cold first
# turn of a session. Pings are tiny (1-token generate / 1-passage rerank /
# 1-text embed) — a few hundred ms of GPU work per cycle.
#
# Tokens/URLs are read from Ask's .env so they survive rotation (never printed).
set -u

# Defaults to the .env of the worktree this script lives in, not a pinned path.
# /selfhosted/ask is now the STAGING tree — prod's .env moved to
# /selfhosted/ask-prod with the worktree split — so the old hardcoded default
# had this reading staging's configuration regardless of which stack it warms.
ENV_FILE="${KEEP_WARM_ENV_FILE:-$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)/.env}"
INTERVAL="${KEEP_WARM_INTERVAL:-8}"

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }

# NOTE: the CLASSIFIER moved to glm-5.2:cloud (2026-07-26) and no longer runs
# here. Serenity still hosts granite4.1:8b for the MEMORY EXTRACTOR and the
# fallback query expander, so it is still worth keeping warm — for those, not
# for classification. Warming a :cloud model is pointless (no GPU to wake) and
# is a billed call, so this deliberately targets LOCAL_LLM_BASE_URL.
CLASSIFIER_BASE="$(getenv LOCAL_LLM_BASE_URL)"; CLASSIFIER_BASE="${CLASSIFIER_BASE:-http://192.168.50.171:11434}"
CLASSIFIER_MODEL="$(getenv MEMORY_EXTRACTOR_MODEL_ID)"; CLASSIFIER_MODEL="${CLASSIFIER_MODEL:-granite4.1:8b}"
RERANKER_URL="$(getenv RERANKER_URL)"
RERANKER_TOKEN="$(getenv RERANKER_API_TOKEN)"
EMBED_URL="$(getenv EMBEDDING_SERVICE_URL)"
EMBED_TOKEN="$(getenv EMBEDDING_SERVICE_TOKEN)"
EMBED_MODEL="$(getenv EMBEDDING_MODEL)"

warm_once() {
  # Classifier / granite (Ollama) — tiny generate, keep the model pinned too.
  curl -s -m 8 "${CLASSIFIER_BASE%/}/api/generate" \
    -d "{\"model\":\"${CLASSIFIER_MODEL}\",\"prompt\":\"ok\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" \
    >/dev/null 2>&1

  # Reranker — one query/one passage.
  [ -n "$RERANKER_TOKEN" ] && curl -s -m 8 "${RERANKER_URL%/}/rerank" \
    -H "Authorization: Bearer ${RERANKER_TOKEN}" -H "Content-Type: application/json" \
    -d '{"query":"warm","passages":["warm"]}' >/dev/null 2>&1

  # Embedder — one text (already tends to stay warm, pinged for parity/safety).
  [ -n "$EMBED_TOKEN" ] && curl -s -m 8 "${EMBED_URL%/}/embed" \
    -H "Authorization: Bearer ${EMBED_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"texts\":[\"warm\"],\"model\":\"${EMBED_MODEL}\",\"kind\":\"query\"}" >/dev/null 2>&1
}

while true; do
  warm_once
  sleep "$INTERVAL"
done
