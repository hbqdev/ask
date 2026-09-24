#!/usr/bin/env bash
# Smoke-test every FLOW_VARIANT against the lab instance.
#
# Unit tests cover what a variant RETURNS; they cannot catch a forced
# toolChoice the model refuses, a stripped tool set that deadlocks the loop, or
# a per-step system prompt that makes the model never emit a `## ` heading.
# Those only show up against a live model, so every arm gets one real turn here
# before any of them get a full benchmark run.
#
# Usage: smoke-flows.sh [question]
set -uo pipefail

# Lab = the ask-flow worktree, project ask-stack-lab, container ask-lab, :3742
# on NightFuryX (.17) — the `lab` case of fleet-boot/rebuild-ask.sh. The compose
# call below MUST run from the lab's own worktree: compose reads `.env` and the
# build context from the project dir, so running it from another checkout (this
# used to cd into the staging worktree) recreates ask-lab on THAT stack's .env.
LAB="${ASK_LAB_URL:-http://localhost:3742}"
LAB_DIR="${ASK_LAB_DIR:-/home/nightfury/selfhosted/ask-flow}"
MODEL="${EVAL_MODEL:-kimi-k2.6:cloud}"
# Must include the VPN overlay — see the note in run-flow-conversations.py.
COMPOSE="-f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml"
PROJ=ask-stack-lab
Q="${1:-What is the difference between TCP and UDP?}"
VARIANTS="baseline adaptive react-gap plan-execute wide-once"

cd "$LAB_DIR" || exit 1
[ -f docker-compose.lab.yaml ] || { echo "$LAB_DIR is not the lab worktree" >&2; exit 1; }
RUNNING_FROM=$(docker inspect ask-lab --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null)
if [ -n "$RUNNING_FROM" ] && [ "$(realpath "$RUNNING_FROM")" != "$(realpath "$LAB_DIR")" ]; then
  echo "ask-lab runs from $RUNNING_FROM, not $LAB_DIR — refusing to recreate it (set ASK_LAB_DIR if the lab moved)" >&2
  exit 1
fi

for V in $VARIANTS; do
  FLOW_VARIANT="$V" docker compose $COMPOSE -p $PROJ up -d ask >/dev/null 2>&1
  until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $LAB/ 2>/dev/null)" = "200" ]; do sleep 2; done
  docker exec ask-redis-lab redis-cli del latency:log >/dev/null 2>&1

  CHAT="smoke_${V//-/_}_$(date +%s)"
  START=$(date +%s)
  CODE=$(curl -s -o /tmp/smoke-body.txt -w '%{http_code}' --max-time 290 \
    -X POST "$LAB/api/chat" \
    -H 'Content-Type: application/json' \
    -H 'Connection: close' \
    -H "Cookie: selectedModel=ollama:${MODEL//:/%3A}; searchMode=balanced" \
    -d "{\"chatId\":\"$CHAT\",\"trigger\":\"submit-message\",\"isNewChat\":true,\"message\":{\"id\":\"m_$CHAT\",\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":$(printf '%s' "$Q" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}]}}" 2>/dev/null)
  ELAPSED=$(( $(date +%s) - START ))

  # The turn is only really OK if it produced an answer, not just a 200.
  ANSWER_CHARS=$(grep -o '"text"' /tmp/smoke-body.txt 2>/dev/null | wc -l)
  LINE=$(docker exec ask-redis-lab redis-cli lrange latency:log 0 -1 2>/dev/null | grep '^\[latency\] ' | head -1)
  SUMMARY=$(printf '%s' "$LINE" | python3 -c "
import sys,json
raw=sys.stdin.read().strip()
if not raw: print('   no telemetry'); raise SystemExit
t=json.loads(raw.split(' ',1)[1])
print('   variant=%-13s total=%6.1fs steps=%-3s tools=%-3s' % (
  t.get('variant'), (t.get('total_ms') or 0)/1000, t.get('steps'), t.get('tool_calls')))
" 2>/dev/null)

  printf '%-13s HTTP %s  %3ds  text-parts=%-4s\n%s\n' "$V" "$CODE" "$ELAPSED" "$ANSWER_CHARS" "$SUMMARY"
  docker logs ask-lab --since 6m 2>&1 | grep -E "^\[flow\]" | tail -1 | sed 's/^/   /'
done
