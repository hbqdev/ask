#!/usr/bin/env bash
# Weekly NOTIFY-ONLY check for a newer crawl4ai release.
#
# crawl4ai is PINNED (not :latest) on purpose: it's a critical search-enrichment
# dependency, and its minor/major bumps carry real breaking changes (0.9.0
# required auth tokens, removed request fields, changed hooks/CORS/Redis). PATCH
# bumps within a minor (e.g. 0.9.1 -> 0.9.2) are safe bug-fixes. So this script
# only REPORTS a newer version — it never auto-applies. When it flags one, do a
# reviewed bump: check the changelog for breaking changes, edit the pins in
# crawl4ai/docker-compose*.yaml, `docker compose -p crawl4ai pull && up -d`,
# then verify the container is healthy.
set -uo pipefail

COMPOSE=/home/nightfury/selfhosted/crawl4ai/docker-compose.yaml
LOG=/home/nightfury/selfhosted/logs/update-public-search.log
mkdir -p "$(dirname "$LOG")"

current="$(grep -oE 'unclecode/crawl4ai:[0-9]+\.[0-9]+\.[0-9]+' "$COMPOSE" 2>/dev/null | head -1 | cut -d: -f2)"
latest="$(curl -fsSL 'https://hub.docker.com/v2/repositories/unclecode/crawl4ai/tags?page_size=100' 2>/dev/null \
  | grep -oE '"name":"[0-9]+\.[0-9]+\.[0-9]+"' | sed 's/.*:"//; s/"$//' | sort -V | tail -1)"

{
  ts="$(date '+%F %T %Z')"
  if [[ -z "$current" ]]; then
    echo "[$ts] crawl4ai check: could not read the current pin from $COMPOSE — skipped."
  elif [[ -z "$latest" ]]; then
    echo "[$ts] crawl4ai check: could not reach Docker Hub — skipped (running $current)."
  elif [[ "$current" == "$latest" ]]; then
    echo "[$ts] crawl4ai up to date ($current)."
  else
    IFS=. read -r cM cm _ <<<"$current"; IFS=. read -r lM lm _ <<<"$latest"
    if [[ "$cM.$cm" == "$lM.$lm" ]]; then
      kind="PATCH (bug-fix, low risk)"
    else
      kind="MINOR/MAJOR (BREAKING RISK — review the changelog + deploy/docker/MIGRATION.md)"
    fi
    echo "[$ts] >> crawl4ai $latest available (running $current) — $kind."
    echo "        Reviewed bump: edit pins in crawl4ai/docker-compose*.yaml, 'docker compose -p crawl4ai pull && up -d', verify healthy. (Auto-apply is intentionally OFF for this critical dep.)"
  fi
} | tee -a "$LOG"
