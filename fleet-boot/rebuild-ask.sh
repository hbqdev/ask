#!/usr/bin/env bash
# Rebuild an Ask app stack from source, recreate the app container, health-check
# it, then ALWAYS reclaim the space the build left behind (dangling images +
# unused build cache). Use this instead of a bare `docker compose up -d --build`
# so the reclaim step is never skipped after a rebuild.
#
# Runs on the app host (NightFuryX .17), where all three stacks now live.
#
# Usage: ./rebuild-ask.sh {prod|staging|lab}
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  prod)
    DIR=/home/nightfury/selfhosted/ask-prod
    PROJ=ask-stack
    PORT=3738
    FILES=(-f docker-compose.yaml -f docker-compose.vpn.yaml)
    ;;
  staging)
    DIR=/home/nightfury/selfhosted/ask
    PROJ=ask-stack-admin-feature
    PORT=3739
    FILES=(
      -f docker-compose.yaml -f docker-compose.admin-feature.yaml
      -f docker-compose.vpn.yaml -f docker-compose.vpn.admin-feature.yaml
    )
    ;;
  lab)
    DIR=/home/nightfury/selfhosted/ask-flow
    PROJ=ask-stack-lab
    PORT=3742
    FILES=(-f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml)
    ;;
  *)
    echo "usage: $0 {prod|staging|lab}"
    exit 2
    ;;
esac

echo "== rebuild $1 ($PROJ) from $DIR =="
if ! ( cd "$DIR" && docker compose "${FILES[@]}" -p "$PROJ" up -d --build ask ); then
  echo "!! build/up failed — NOT reclaiming (leave the cache for a retry)"
  exit 1
fi

echo "-- waiting for :$PORT to serve --"
for i in $(seq 1 72); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:$PORT/" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "   :$PORT -> 200 (after ~$((i * 5))s)"
    break
  fi
  sleep 5
done
printf '   final :%s -> %s\n' "$PORT" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://localhost:$PORT/" 2>/dev/null)"

# Always reclaim after a successful rebuild. reclaim-space.sh prunes dangling
# images + unused build cache only — never -a, never containers/volumes.
echo "-- reclaiming space --"
bash "$HERE/reclaim-space.sh" 2>&1 | tail -8
echo "== done =="
