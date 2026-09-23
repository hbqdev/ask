---
title: Runbooks
---

# Runbooks

Incident playbooks, each as **symptoms → diagnosis → fix**. All commands run on the app
host **NightFuryX (192.168.50.17)** unless stated otherwise; other hosts are reachable as
`ssh nightfury@<ip>` with key auth (`.160`, `.171`, `.231`). Host roles are in
[Fleet](/infrastructure/fleet); ports and env vars in [Services](/infrastructure/services).

::: danger Before you touch anything
- Never `docker compose` with only the base file — it targets **prod**. Use the env's full
  `-p`/`-f` set (see [Environments](/operations/environments#compose-projects)) or
  `fleet-boot/rebuild-ask.sh`.
- Never `docker compose down -v` on an Ask stack (deletes the database and uploads).
- Don't diagnose search by firing test queries — use logs
  ([why](/operations/testing-qa#no-live-search-probing)).
- When reading `.env` or `printenv`, mask values
  ([how](/getting-started/local-dev#environment-files)).
:::

## What automation already exists

Knowing what self-heals tells you what *should* have happened before you intervene.

| Mechanism | Where | When | What it does |
|---|---|---|---|
| `restart: unless-stopped` | every container | always | Restarts crashed containers (does **not** fix a container attached to a stale/wrong network, and gives up after its backoff). |
| `ask-fleet-boot.service` → `~/ask-fleet-boot.sh` | .17, .160, .171, .231 (all synced by `fleet-boot/deploy.sh`) | once per boot (systemd oneshot) | Host-aware reconcile. On **.17**: waits for Docker, reconciles `reranker-qwen`, the three ingestors (`ingestor`, `ingestor-staging`, `ingestor-lab`), `ask-whisper`; warms `qwen3-vl:4b`; ensures the Whisper model; after a 15 s settle runs `reconcile_app_stack` for prod/staging/lab (up → force-recreate → down/up, gated on health); `ensure_vpn_search` retries gluetun+searxng 6×10 s per stack; reconciles `model-manager`. On **.160**: reconciles `embedder`. On **.171**: warms `granite4.2:8b`. On **.231**: reconciles `crawl4ai` and `flaresolverr` only. Source: `fleet-boot/ask-fleet-boot.sh`. |
| Docker healthcheck | `ask*` containers | every 30 s | `GET /api/health` (liveness only). Marks unhealthy but does **not** restart. |
| `expire-uploads-daily.sh` | .17 cron `15 4 * * *` | daily | Upload TTL sweep on :3738/:3739/:3742. Log: `~/.local/state/fleet-boot/expire-uploads-daily.log`. |
| `docker-maintenance.sh` | .17 cron `30 4 * * *` | daily | Dangling-image prune, 7-day build-cache prune, disk warning ≥ 85 %, btree `amcheck`. Log: `~/logs/docker-maintenance.log`. |
| `rotate-daily.sh` | .17 cron `0 5 * * *` (`ask-prod ask-staging ask-lab`); .231 cron `0 5 * * *` runs `~/fleet-boot/rotate-daily.sh public-searxng degoog` (a copy synced by `deploy.sh`) | daily | Rotates the named stacks' Mullvad exits and clears Ask's per-engine health suspensions. Log: `~/.local/state/fleet-boot/rotate-daily.log`. |
| `update-ollama-fleet.sh` | .17 cron `30 3 * * 0` | weekly | Upgrades native Ollama on all four hosts and re-pins resident models. Log: `~/.local/state/fleet-boot/update-ollama.log`. |
| `fleet-update-ask.timer` | .17 systemd | Sun 04:30 | Pulls + recreates prod/staging **sidecar** images (never the app). Log: `/home/nightfury/selfhosted/logs/update-ask.log`. |
| `memory-watchdog.sh` | .231 cron `*/15` | every 15 min | Restarts `crawl4ai` above 80 % of its 8 GiB cgroup limit. Log: `~/logs/crawl4ai-watchdog.log` on .231. |
| `lan_automation` fleet-boot/sentinel | .17 systemd (outside this repo) | boot + every 15 min | Monitors all stacks; for Ask it defers recovery to `ask-fleet-boot.service`. |

Check the last boot reconcile on any host:

```bash
journalctl -u ask-fleet-boot.service -b --no-pager -o cat
```

A healthy .17 boot ends with `ask -> healthy`, `ask-admin-feature -> healthy`,
`ask-lab -> healthy`, three `… ok (gluetun=healthy searxng=running)` lines and `done`.
Re-run it by hand at any time — every step is idempotent and leaves healthy services
untouched:

```bash
sudo systemctl start ask-fleet-boot.service     # or: ~/ask-fleet-boot.sh
```

---

## Reading logs

| What | Command |
|---|---|
| App (prod / staging / lab) | `docker logs --since 30m ask` · `ask-admin-feature` · `ask-lab` |
| Follow live | `docker logs -f --tail 100 ask` |
| Per-turn latency lines | `docker logs --since 1h ask 2>&1 \| grep '\[latency'` — see [Telemetry](/operations/telemetry) |
| Stop / abort events | `docker logs --since 1h ask 2>&1 \| grep '\[stop\]'` |
| SearXNG engine errors | `docker logs --since 1h ask-searxng 2>&1 \| tail -50` |
| VPN tunnel | `docker logs --since 1h ask-gluetun 2>&1 \| tail -50` |
| Container state | `docker ps -a --format '{{.Names}}\t{{.Status}}' \| grep -E '^ask'` |
| Boot reconcile | `journalctl -u ask-fleet-boot.service -b -o cat` |
| crawl4ai (on .231) | `ssh nightfury@192.168.50.231 'docker logs --since 30m crawl4ai; docker stats --no-stream crawl4ai'` |

At container start the log should show `Running database migrations...`,
`Migrations completed successfully`, then Next.js `Ready`. Anything else before `Ready`
is a boot failure.

---

## Host reboot strands prod on the wrong network

**Symptoms**
- After a reboot of the app host, `ask` is `Restarting` or `Exited (1)`; `:3738` returns
  `000`, while `:3739`/`:3742` may be fine.
- `docker logs ask` shows the boot migration failing with
  `DNSException: getaddrinfo ENOTFOUND` on `CREATE SCHEMA IF NOT EXISTS "drizzle"` — it
  cannot resolve `postgres`.

**Diagnosis**

The `ask` service joins two networks: `ask-stack_default` (postgres, redis, gluetun) and
the external `shared-infra` (`docker-compose.yaml:158-164`). After a reboot the container
can be recreated attached to **only** `shared-infra`:

```bash
docker inspect ask --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# broken: "shared-infra"      healthy: "ask-stack_default shared-infra"
```

A plain `docker compose up -d ask` does not fix it (it re-attaches the same way).

**Fix**

`ask-fleet-boot.sh`'s `reconcile_app_stack` does this automatically at boot. By hand:

```bash
cd /home/nightfury/selfhosted/ask-prod
docker stop ask
docker compose -p ask-stack -f docker-compose.yaml -f docker-compose.vpn.yaml \
  up -d --force-recreate ask
docker inspect ask --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker exec ask getent hosts postgres
```

For staging/lab, the same with their worktree, `-p` and `-f` set (container
`ask-admin-feature` / `ask-lab`). If still unhealthy, `down` then `up -d` the whole stack
with the full file set (volumes survive).

---

## Search dead after boot: gluetun / SearXNG VPN sidecar down

**Symptoms**
- App is up and healthy, but quality-mode searches return nothing or error; balanced/speed
  still answer (they do not use SearXNG).
- `docker ps -a` shows `ask-gluetun*` `Exited (127)` and `ask-searxng*` `Exited (255)`
  or "Up" with no network.

**Diagnosis**

On a cold boot Docker Desktop's networking and `/dev/net/tun` come up after the engine,
so gluetun can lose the race and exit 127. SearXNG runs inside gluetun's network
namespace (`network_mode: service:gluetun`) and dies or is left with a dead namespace.
The app itself does not share that namespace, so it reports healthy, and
`restart: unless-stopped` gives up after its backoff.

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E 'gluetun|searxng'
docker logs --tail 30 ask-gluetun
journalctl -u ask-fleet-boot.service -b -o cat | grep -E 'gluetun|STILL'
```

**Fix**

`ensure_vpn_search` in `ask-fleet-boot.sh` retries this at boot. By hand, bring gluetun
and searxng up **together** (per stack):

```bash
cd /home/nightfury/selfhosted/ask-prod
docker compose -p ask-stack -f docker-compose.yaml -f docker-compose.vpn.yaml up -d gluetun searxng
# staging: in ../ask with -p ask-stack-admin-feature and its four -f files
# lab:     in ../ask-flow with -p ask-stack-lab and its three -f files
```

::: warning Don't `docker restart ask-gluetun` on its own
SearXNG keeps running with a dead namespace (its UI returns 000) until it is recreated.
To change the exit IP use `fleet-boot/rotate-mullvad.sh rotate ask-prod --clear-health`,
which reconnects the tunnel in place; `pin`/`city` verbs recreate and then restart the
dependent service for you.
:::

`pin` and `city` run `docker compose` from each stack's own worktree (`ask-prod`, `ask`,
`ask-flow`), so each reads its own `.env` and compose files. Until 2026-09-23 all three ran
from the staging worktree.

If searches work but many engines are "suspended": Ask suspends engines by name for
30 minutes after errors (`lib/search/engine-health.ts`). After rotating an exit IP, clear
those with `--clear-health` (the daily rotation already does).

**Boot-chain fragilities to check if nothing came back at all:** the app host auto-logs
in to Windows (`AutoAdminLogon=1`) so Docker Desktop (`AutoStart: true`) can start. If
either setting is changed, a reboot waits at the login screen with every container
down. Log in and Docker Desktop will start everything; then run
`sudo systemctl start ask-fleet-boot.service`.

---

## crawl4ai memory saturation (slow retrieval)

**Symptoms**
- Advanced-search turns suddenly take minutes; `[latency:search]` lines show a very large
  `slowest_chunk_ms` (e.g. ~125 000) and chunk failures / `Crawl4AI HTTP 500`.
- Answers still arrive (the pipeline falls back to the in-process crawler) but slowly.

**Diagnosis**

crawl4ai runs on **MiniNightFury (.231)** with `mem_limit: 8g`. Its built-in guard
(`memory_threshold_percent: 95`) reads host RAM via `psutil` (31 GiB), not the cgroup
limit, so it can never trigger; Chromium memory grows until the pool churns.

```bash
ssh nightfury@192.168.50.231 'docker stats --no-stream crawl4ai; tail -20 ~/logs/crawl4ai-watchdog.log'
docker logs --since 1h ask 2>&1 | grep 'latency:search' | tail -5
```

A fresh container sits around 2 GiB; trouble starts above ~6 GiB.

**Fix**

- The watchdog (`~/selfhosted/crawl4ai/memory-watchdog.sh` on .231, cron `*/15`) restarts
  it above 80 % of the cgroup limit. To act now:
  `ssh nightfury@192.168.50.231 docker restart crawl4ai`. In-flight crawls fall back to
  the legacy crawler; nothing else is affected.
- Do **not** raise crawl parallelism, workers, `mem_limit` or `shm_size`: a benchmark
  showed throughput peaks at ~24–32 concurrent pages (~2.2 pages/s) and regresses beyond,
  because rendering is single-thread and remote-tail-latency bound. Ask's fan-out
  (`CRAWL4AI_MAX_CONCURRENT_CHUNKS=6` × chunk size 8) is already at that ceiling.
- crawl4ai is pinned (`unclecode/crawl4ai:0.9.2`); `fleet-boot/check-crawl4ai-version.sh`
  only reports new releases. Minor/major bumps have broken the API before — upgrade by
  hand after reading the changelog.

If retrieval is slow, check crawl4ai **before** suspecting code or model changes.

---

## Ollama model not resident after a restart

**Symptoms**
- First turn after a host or Ollama restart is slow (cold model load), or `nvidia-smi`
  shows an idle GPU on a box that should hold a model.

**Diagnosis**

Ollama runs **natively** as a systemd service on every host (not in Docker), so
restarting Docker does not restart it — but restarting Ollama (or the weekly upgrade)
leaves **no model loaded**: `keep_alive=-1` only pins a model after its first load.
`ask-fleet-boot.sh` warms models only at **boot**.

```bash
curl -s http://192.168.50.171:11434/api/ps   # expect granite4.2:8b
curl -s http://192.168.50.17:11434/api/ps    # expect qwen3-vl:4b
```

On WSL2 hosts `nvidia-smi` is at `/usr/lib/wsl/lib/nvidia-smi`.

**Fix** — pin it over the HTTP API (no SSH needed):

```bash
curl -s http://192.168.50.171:11434/api/generate \
  -d '{"model":"granite4.2:8b","prompt":"warmup","stream":false,"keep_alive":-1}' >/dev/null
curl -s http://192.168.50.17:11434/api/generate \
  -d '{"model":"qwen3-vl:4b","prompt":"warmup","stream":false,"keep_alive":-1}' >/dev/null
```

The app also re-pins the local model on next use (title, memory and expander calls
send `keep_alive: -1`), and `POST /api/warm` pings the GPUs while a user is typing.
`*:cloud` models have nothing to warm.

::: warning The embedder model is data-locked
The GPU embedder on .160 (`Qwen3-Embedding-0.6B`, 1024-d) produced every vector in
`user_memories` and `conversation_chunks`. Never swap or "upgrade" it without a full
re-embed — a different 1024-d model passes the dimension check and silently corrupts
recall.
:::

---

## A fleet service on .171 / .160 / .231 is unreachable

**Symptoms** (all fail open, so look for *quality* degradation rather than errors)

| Service down | What users see |
|---|---|
| `.171:11434` local LLM (granite) | Chat titles fall back to the first words of the question; no new long-term memories; expander fallback unavailable. |
| `.160:8788` embedder | Recall and memory lookups empty; upload RAG embedding fails (worker path). |
| `.17:8787` reranker | Rerank drops to bi-encoder/keyword tiers (worse source ordering). |
| `.231:11235` crawl4ai | Slower crawling via the in-process fallback. |
| `.231:8191` FlareSolverr | The `fetch` rescue chain skips its bot-wall tier and moves on. |
| `.231:8127` public SearXNG | No SearXNG fallback for prod/staging if their gluetun sidecar dies. |
| `.17:8890` / `.17:8788` TTS / STT | Read-aloud / dictation unavailable; text unaffected. |

**Diagnosis** — work outward from the app:

```bash
# 1. From inside the app container (what the app actually sees)
docker exec ask node -e "fetch('http://192.168.50.171:11434/api/version').then(r=>r.text()).then(console.log).catch(e=>console.log('ERR',e.cause?.code||e.message))"
# 2. From the host
ping -c2 192.168.50.171; curl -s -m5 http://192.168.50.171:11434/api/version
# 3. On the target host
ssh nightfury@192.168.50.171 'systemctl is-active ollama; ss -ltn | grep 11434; uptime'
```

Interpretation:
- `ping` fails → the machine or its WSL VM is down; check the box (power, Windows
  login). All GPU hosts are Windows + WSL2 with auto-login.
- `ping` works, `ECONNREFUSED` → the service is not listening on the LAN. For Ollama,
  check the listen address: `127.0.0.1:11434` means `OLLAMA_HOST` is not set to
  `0.0.0.0` for the systemd unit. Add it in a drop-in
  (`/etc/systemd/system/ollama.service.d/*.conf`: `Environment=OLLAMA_HOST=0.0.0.0:11434`),
  then `sudo systemctl daemon-reload && sudo systemctl restart ollama` and re-pin the
  model (previous section). Keep it in a **drop-in**: the official installer used by
  the weekly `update-ollama.sh` rewrites the main unit file.
- Container services (embedder, reranker, whisper): `docker ps` on that host, then
  `~/ask-fleet-boot.sh` there (it reconciles that host's containers), or
  `docker compose -f /home/nightfury/selfhosted/<service>/docker-compose.yaml up -d`.

::: warning Observed 2026-09-22
Serenity's Ollama (`.171`) was running with `granite4.2:8b` resident but listening on
`127.0.0.1:11434` only, so the app containers got `ECONNREFUSED`. The existing drop-in
(`ollama.service.d/parallel.conf`) sets `OLLAMA_NUM_PARALLEL` and
`OLLAMA_CONTEXT_LENGTH` but not `OLLAMA_HOST`. When this started, and its user impact,
were not established.
:::

---

## degoog

**Facts**
- The **public / personal** degoog on MiniNightFury (`.231`, compose project `degoog`,
  `:4444`, behind its own gluetun) has human users. It is not referenced by any Ask
  container, and that is **not** evidence it is unused. Never stop or decommission it.
- The three per-environment degoog stacks (`degoog-prod` `:4445`, `degoog-staging`
  `:4446`, `degoog-lab` `:4447`) were moved to .17 on 2026-09-07 and are **stopped**, with
  `DEGOOG_ENABLED=false` in every Ask environment. Their boot reconcile
  (`ensure_degoog`) is commented out in `ask-fleet-boot.sh`.

**Public degoog down** (`:4444` not answering):

```bash
ssh nightfury@192.168.50.231
cd /home/nightfury/selfhosted/degoog
docker compose -f docker-compose.yaml -f docker-compose.vpn.yaml up -d
```

Always include the VPN overlay — without it degoog egresses from the residential IP.
`fleet-boot/degoog-engine-watchdog.py` suspends engines upstream is blocking and
restores only the ones it disabled.

**Re-enabling per-env degoog for Ask:** start the stack
(`DEGOOG_INSTANCE=<env> DEGOOG_PORT=<port> docker compose -f docker-compose.yaml -f docker-compose.vpn.yaml -f docker-compose.instance.yaml -p degoog-<env> up -d`
in `/home/nightfury/selfhosted/degoog` on .17), set `DEGOOG_ENABLED=true` for that env,
recreate the app, and uncomment the matching `ensure_degoog` line in the boot script.

---

## Disk full / reclaiming space

**Symptoms** — builds fail with "no space left on device", Postgres or Redis write
errors, `docker-maintenance` warns `root filesystem at N%`.

**Diagnosis**

```bash
df -h /
docker system df
docker system df -v | head -40           # per-image / per-volume detail
du -sh /home/nightfury/logs /home/nightfury/selfhosted/logs 2>/dev/null
```

**Fix**, in order of safety:

1. `/home/nightfury/selfhosted/ask-prod/fleet-boot/reclaim-space.sh` — all unused build
   cache + dangling images. Always safe.
2. Remove stopped containers you have **confirmed** are not rollback or human-used
   services, by name.
3. Unused images by name (`docker rmi <repo:tag>`), never `docker image prune -a`
   blindly.
4. Volumes: only by explicit name, after confirming nothing references them. Ask's
   `ask-postgres-data*` and `ask-uploads*` volumes hold user data.

The app host's root filesystem is ~1 TB with ~2 % used (2026-09-22), so a full disk
there would indicate something abnormal (runaway log or build loop), not normal growth.

---

## A stuck chat

**"The answer keeps spinning" / Stop does nothing**

A turn can run for at most 300 s (`GENERATION_TIMEOUT_MS`,
`app/api/chat/route.ts:36`); after that it is aborted and discarded.

1. Ask the user to press Stop (it calls `POST /api/chat/<chatId>/stop` for any signed-in
   chat). Stop keeps the finished part of the answer.
2. Reload the page. On reload the client asks `GET /api/chat/<chatId>/stream`; if the
   turn already finished it gets 204 and reloads the saved conversation from
   `GET /api/chat/<chatId>/messages`.
3. Server-side, the resumable-stream pointer is the Redis key
   `ask:chat:<chatId>:activeStream` with a 300 s TTL
   (`lib/streaming/resumable-stream-context.ts:16-17`). It expires on its own; to clear
   it immediately:
   `docker exec ask-redis redis-cli DEL ask:chat:<chatId>:activeStream`.
4. The in-memory Stop registry (`lib/streaming/active-generations.ts`) lives in the
   Node process. As a last resort, recreating the app container clears every in-flight
   generation (all users' running turns are lost):
   `docker compose -p ask-stack -f docker-compose.yaml -f docker-compose.vpn.yaml up -d --force-recreate --no-deps ask`
   from `ask-prod`.

**"The answer vanished" / "it answered my previous question again"** — these were
streaming/persistence bugs fixed on 2026-09-22 (see [Streaming](/request-lifecycle/streaming)).
If they recur, capture `docker logs --since 10m ask 2>&1 | grep -E '\[stop\]|persist|chatId'`
around the time and the chat id; do not edit the database by hand.

**An upload stays "processing"** — the ingest worker is external. Check
`docker ps | grep ingestor`, `docker logs --since 30m ingestor`, and the heartbeat:
`docker exec ask-redis redis-cli TTL ingest:heartbeat` (a positive TTL means the worker
polled within the last 60 s). Restart with
`cd /home/nightfury/selfhosted/ingestor && docker compose up -d` (staging/lab use
`-p ingestor-staging` / `-p ingestor-lab` with their compose files). Image OCR via
`qwen3-vl:4b` can legitimately take ~90 s per image.

---

## Rollback

Code rollback = `git revert` on the env's branch + `rebuild-ask.sh`; flag rollback =
change the env var and recreate. Full procedure, including migrations and an optional
instant-rollback image tag: [Deploy › Rollback](/operations/deploy#rollback).

---

## Retired stacks on .231

**Resolved 2026-09-23.** The pre-migration `ask-stack`, `ask-stack-admin-feature` and
`ask-stack-lab` containers on MiniNightFury (`.231`) were stopped and removed. They had been
recreated at .231's 2026-09-16 boot by a stale `~/ask-fleet-boot.sh`, because
`fleet-boot/deploy.sh` never pushed to .231. It does now, and .231's `MiniNightFury` case
reconciles only `crawl4ai` and `flaresolverr`. The legacy cron lines (`ask-expire-uploads.sh`,
rotation of the retired gluetuns) are gone.

Their **volumes were kept** (`ask-postgres-data*`, `ask-redis-data*`, `ask-uploads*`,
`ask-model-cache*`, `ask-searxng-data*`). The three Postgres volumes are ~49 MB each and hold a
stale copy of user data. Removing them is an owner decision:

```bash
ssh nightfury@192.168.50.231 'docker volume ls -q | grep "^ask-"'
# only when you are sure: ... | xargs docker volume rm
```

**If they ever reappear**, check that .231's boot script matches the repo, then re-deploy:

```bash
ssh nightfury@192.168.50.231 'cat ~/ask-fleet-boot.sh' | diff - /home/nightfury/selfhosted/ask-prod/fleet-boot/ask-fleet-boot.sh
bash /home/nightfury/selfhosted/ask-prod/fleet-boot/deploy.sh
```

Public traffic was never affected: `ask.hbqnexus.win` routes to .17.
