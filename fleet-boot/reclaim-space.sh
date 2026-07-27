#!/usr/bin/env bash
# Reclaim Docker disk space after a prod rebuild.
#
# Every `docker compose ... up -d --build` leaves the previous image dangling
# (untagged) and stacks build cache. Run this after each PROD rebuild to keep
# the disk from creeping (tonight's session alone stacked ~23GB).
#
# SAFE — only removes what is genuinely unused:
#   - `builder prune`      : ALL unused build cache (regenerable).
#   - `image prune`        : DANGLING (untagged) images only — NOT `-a`, so
#                            tagged images (incl. rollback images) are kept.
# Does NOT touch stopped containers (the runtipi-searxng rollback container
# stays), volumes, or networks.
set -u

echo "=== reclaim-space: before ==="
df -h / | tail -1

docker builder prune -f >/dev/null 2>&1
docker image prune -f  >/dev/null 2>&1

echo "=== reclaim-space: after ==="
df -h / | tail -1
docker system df 2>/dev/null | grep -iE 'build cache|images' || true
