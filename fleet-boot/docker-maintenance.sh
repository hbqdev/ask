#!/usr/bin/env bash
# Daily docker + disk maintenance for the Ask app host (NightFuryX .17).
# Ported from the original .231 ~/docker-maintenance.sh in the 2026-08-27 crontab
# restore (the .231->.17 migration had dropped nightfury's crontab). Now lives in
# the repo (committed to every worktree) instead of a loose ~ script.
# Conservative by design:
#   - `docker image prune -f`          → DANGLING layers only (never removes
#                                        tagged or in-use images)
#   - `docker builder prune`           → build cache unused for 7+ days
#   - disk report + high-water warning → journald via logger
#   - btree index integrity (amcheck)  → catches collation/corruption damage
# Cron: 30 4 * * *
set -u

LOG=/home/nightfury/logs/docker-maintenance.log
mkdir -p "$(dirname "$LOG")"

{
  echo "=== docker-maintenance $(date -Is) ==="

  echo "--- disk before ---"
  df -h / | tail -1
  docker system df

  echo "--- image prune (dangling only) ---"
  docker image prune -f

  echo "--- builder cache prune (unused >7d) ---"
  docker builder prune -f --filter until=168h

  echo "--- disk after ---"
  df -h / | tail -1

  USED_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  if [ "${USED_PCT:-0}" -ge 85 ]; then
    logger -t docker-maintenance "WARNING: root filesystem at ${USED_PCT}% after prune — investigate (docker system df, /home/nightfury/selfhosted volumes)"
    echo "WARNING: root filesystem at ${USED_PCT}% after prune"
  fi

  # --- btree index integrity -------------------------------------------------
  # Postgres normally warns when the glibc collation version changes, because a
  # text index built under the old sort order silently stops matching rows an
  # index scan should find. That warning cannot fire here: pg_database.
  # datcollversion is NULL on staging, and ALTER DATABASE ... REFRESH COLLATION
  # VERSION refuses NULL -> non-NULL (dbcommands.c, "invalid collation version
  # change"), so the alarm cannot be armed at all.
  #
  # bt_index_check is the stronger check anyway: it verifies actual index
  # ordering against current collation rules, so it catches the damage rather
  # than the risk factor. Read-only, takes only AccessShareLock, and skips
  # cleanly if a container is down.
  echo "--- btree index check (amcheck) ---"
  for C in ask-postgres ask-postgres-admin-feature ask-postgres-lab; do
    if ! docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null | grep -q true; then
      echo "$C: not running — skipped"
      continue
    fi
    docker exec "$C" psql -U morphic -d morphic -tA \
      -c "create extension if not exists amcheck;" >/dev/null 2>&1
    OUT=$(docker exec "$C" psql -U morphic -d morphic -tA -c "
      do \$\$
      declare r record; bad int := 0; ok int := 0;
      begin
        for r in select c.oid::regclass idx from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                 join pg_am a on a.oid = c.relam
                 where c.relkind='i' and n.nspname='public'
                   and a.amname='btree' and c.relpersistence='p'
        loop
          begin perform bt_index_check(r.idx); ok := ok + 1;
          exception when others then
            bad := bad + 1;
            raise warning 'CORRUPT INDEX %: %', r.idx, sqlerrm;
          end;
        end loop;
        raise notice '% ok, % corrupt', ok, bad;
      end \$\$;" 2>&1)
    echo "$C: $(echo "$OUT" | grep -oE '[0-9]+ ok, [0-9]+ corrupt' | tail -1)"
    if echo "$OUT" | grep -q 'CORRUPT INDEX'; then
      logger -t docker-maintenance "WARNING: corrupt btree index in $C — REINDEX required"
      echo "$OUT" | grep 'CORRUPT INDEX'
    fi
  done
} >> "$LOG" 2>&1

# Keep the log itself from becoming the leftover file (~last 5000 lines).
tail -n 5000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
