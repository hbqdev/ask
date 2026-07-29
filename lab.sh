#!/usr/bin/env bash
# The lab stack, built from THIS worktree (branch `flow-design`).
#
# WHY THIS EXISTS. Until now every stack was built from one working tree on
# `admin-feature`, which is also what gets pushed to `dev` — and `dev` IS
# production. So "lab-only" experiments were only ever isolated by an env var
# (FLOW_VARIANT) and by which container got rebuilt. Anything NOT variant-gated
# — a change to the tool wrappers, the researcher, the prompts — landed on the
# same branch as production and shipped on the next prod rebuild. That is the
# opposite of what a testbed is for, and it is why a partial fix ended up on
# the production branch unproven.
#
# `docker compose` resolves `context: .` relative to the directory it runs in,
# so running it HERE builds the lab image from the flow-design worktree. This
# script exists so that is enforced rather than remembered.
#
# The main worktree (/home/nightfury/selfhosted/ask, branch admin-feature)
# stays the only source for prod and staging. Radical redesigns go here and
# only graduate by an explicit merge.
#
#   ./lab.sh build          rebuild the lab image from this worktree
#   ./lab.sh up             (re)start the lab container
#   ./lab.sh deploy         build + up + verify
#   ./lab.sh status         what lab is running, and from which branch
#   ./lab.sh <variant>      deploy with FLOW_VARIANT set
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

COMPOSE="-f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml"
PROJ=ask-stack-lab
LAB=http://192.168.50.231:3742

# Refuse to run from the wrong tree. Building lab from the prod worktree is the
# exact mistake this script prevents, and it fails silently otherwise.
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$BRANCH" != "flow-design" ]; then
  echo "refusing: expected branch flow-design in $HERE, found '$BRANCH'" >&2
  exit 2
fi

# Docker's build context does not follow a symlink that points outside it — it
# copies the dangling link, and `next build` then dies on ENOENT /app/.env.
# So .env is a real copy, refreshed from the main worktree before every build
# to keep that file the single source of truth rather than letting the two
# quietly diverge.
sync_env() {
  local src=/home/nightfury/selfhosted/ask/.env
  [ -f "$src" ] || { echo "missing $src" >&2; return 1; }
  cp "$src" "$HERE/.env" && chmod 600 "$HERE/.env"
}

wait_up() {
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LAB/" 2>/dev/null)" = "200" ] && return 0
    sleep 4
  done
  return 1
}

case "${1:-deploy}" in
  build)
    sync_env || exit 1
    docker compose $COMPOSE -p $PROJ build ask
    ;;
  up)
    docker compose $COMPOSE -p $PROJ up -d ask && wait_up && echo "lab up"
    ;;
  status)
    echo "worktree : $HERE"
    echo "branch   : $BRANCH  ($(git rev-parse --short HEAD))"
    echo "http     : $(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "$LAB/" 2>/dev/null)"
    echo "variant  : $(docker exec ask-lab printenv FLOW_VARIANT 2>/dev/null || echo '<unset>')"
    echo "image    : $(docker inspect -f '{{.Created}}' "$(docker inspect -f '{{.Image}}' ask-lab 2>/dev/null)" 2>/dev/null | cut -c1-19)"
    ;;
  deploy)
    sync_env || exit 1
    docker compose $COMPOSE -p $PROJ build ask || exit 1
    docker compose $COMPOSE -p $PROJ up -d ask || exit 1
    wait_up && echo "lab deployed from $BRANCH $(git rev-parse --short HEAD)" || { echo "lab did not come up" >&2; exit 1; }
    ;;
  *)
    # Treat any other argument as a flow variant to run with.
    FLOW_VARIANT="$1" docker compose $COMPOSE -p $PROJ up -d ask || exit 1
    wait_up || { echo "lab did not come up" >&2; exit 1; }
    got="$(docker exec ask-lab printenv FLOW_VARIANT 2>/dev/null)"
    [ "$got" = "$1" ] || { echo "variant mismatch: asked $1, got '$got'" >&2; exit 1; }
    echo "lab running variant $got"
    ;;
esac
