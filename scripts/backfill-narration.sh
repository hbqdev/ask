#!/usr/bin/env bash
# Run scripts/backfill-narration.ts against ONE environment's database.
#
#   scripts/backfill-narration.sh <lab|staging|prod> [backfill-narration.ts args…]
#
# How it reaches the right database without exposing anything:
#   - reads DATABASE_URL (the OWNER role the app's dbAdmin uses) and the
#     recall embedder settings from that env's RUNNING app container config
#     (`docker inspect`, read-only) into a 0600 temp env-file — nothing is
#     printed, DATABASE_RESTRICTED_URL / ENABLE_AUTH are deliberately not
#     passed, and RECALL_ENABLED (a serving toggle) is not passed either;
#   - runs the script in a THROWAWAY container (`docker run --rm`, the env's
#     own app image for bun, entrypoint overridden so no migration runs) on
#     that stack's docker network, where the host `postgres` in DATABASE_URL
#     resolves to that env's Postgres. No existing container is touched;
#   - mounts this worktree read-only (code + node_modules) and the output dir
#     read-write at the same paths, and uses `bun --no-env-file` so the
#     worktree's .env (the LAB's) can never leak into another env's run.
#
# Output: the directories of --backup / --report are created (0700 if new) and
# mounted at the same path; a report without --report goes to
# $BACKFILL_OUT_DIR (default ~/selfhosted/backups/narration-backfill).
set -euo pipefail

usage() {
  echo "usage: $0 <lab|staging|prod> [--backup FILE] [--apply] [--reindex] [--verify] [--report FILE] [--since YYYY-MM-DD] [--chat ID] [--spot N]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
env_name=$1
shift
case "$env_name" in
  lab) app=ask-lab net=ask-stack-lab_default image=ask-stack-lab-ask:latest ;;
  staging) app=ask-admin-feature net=ask-stack-admin-feature_default image=ask-stack-admin-feature-ask:latest ;;
  prod) app=ask net=ask-stack_default image=ask-stack-ask:latest ;;
  *) usage ;;
esac

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${BACKFILL_OUT_DIR:-$HOME/selfhosted/backups/narration-backfill}
mounts=("$out")
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --backup | --report)
      file=$(realpath -m "${args[$((i + 1))]:?${args[$i]} needs a value}")
      args[i + 1]=$file
      mounts+=("$(dirname "$file")")
      ;;
  esac
done
volume_args=()
declare -A seen=()
for dir in "${mounts[@]}"; do
  [[ -n ${seen[$dir]:-} ]] && continue
  seen[$dir]=1
  # Only a directory created here is made private; never chmod an existing one.
  [[ -d $dir ]] || { mkdir -p "$(dirname "$dir")" && mkdir -m 700 "$dir"; }
  volume_args+=(-v "$dir:$dir")
done

envfile=$(mktemp)
chmod 600 "$envfile"
trap 'rm -f "$envfile"' EXIT
docker inspect "$app" --format '{{range .Config.Env}}{{println .}}{{end}}' |
  grep -E '^(DATABASE_URL|DATABASE_SSL_DISABLED|EMBEDDING_MODEL|EMBEDDING_SERVICE_URL|EMBEDDING_SERVICE_TOKEN|RECALL_CHUNK_TOKENS|RECALL_CHUNK_OVERLAP)=' \
    >"$envfile"
grep -q '^DATABASE_URL=' "$envfile" || {
  echo "no DATABASE_URL in $app's config" >&2
  exit 1
}
{
  echo "BACKFILL_ENV=$env_name"
  echo "BACKFILL_OUT_DIR=$out"
  echo "NODE_ENV=production"
  echo "HOME=/tmp"
} >>"$envfile"

docker run --rm \
  --network "$net" \
  --user "$(id -u):$(id -g)" \
  --env-file "$envfile" \
  -v "$repo:$repo:ro" \
  "${volume_args[@]}" \
  -w "$repo" \
  --entrypoint bun \
  "$image" \
  --no-env-file scripts/backfill-narration.ts "${args[@]}"
