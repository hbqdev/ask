---
title: Services
---

# Services

This page covers every process Ask depends on, one section each. Each section gives: **host and
port**, **auth**, **who calls it**, **config keys** (names only; values live in each worktree's
`.env` or compose overlay), and **what fails and how the app degrades**.

The facts come from the running containers' environment (`docker inspect`, with values
masked), the compose files and the client code, all checked 2026-09-22. Per-env variable values
are in [Env flags](/reference/env-flags). Compose services per env are in
[Compose services](/reference/compose-services).

::: tip General degradation rule
Nearly every dependency **fails open**. If a service is down, the pipeline skips it or falls back
to a cheaper tier instead of erroring the turn. The hard dependencies are **Postgres** (no
persistence, and the container won't boot because the boot migration fails), **Ollama Cloud via
.17** (no answering model), **Supabase** (prod and staging can't authenticate anyone) and, **in
quality mode, SearXNG** (the only fan-out source whose rejection throws).
:::

## Quick reference

| Service | Host : port | Auth | Env key(s) | If it's down |
|---|---|---|---|---|
| [App stacks](#app-stacks) | .17 : 3738 / 3739 / 3742 | Supabase session (lab: none) | n/a | n/a |
| [Postgres](#postgres) | .17, per-env container, no host port | password (owner / `app_user`) | `DATABASE_URL`, `DATABASE_RESTRICTED_URL` | App won't boot or persist |
| [Redis](#redis) | .17, per-env container, no host port | none (private compose network) | `LOCAL_REDIS_URL` | Cache/resume/budgets degrade |
| [Ollama](#ollama) | .17 / .171 / .231 : 11434 | **none** | `OLLAMA_BASE_URL`, `CLASSIFIER_OLLAMA_BASE_URL`, `LOCAL_LLM_BASE_URL` | No answers (.17); titles/memory degrade (.171) |
| [Reranker](#reranker) | .17 : 8787 | Bearer, timing-safe, fails closed | `RERANKER_URL`, `RERANKER_API_TOKEN` | Bi-encoder → keyword fallback |
| [Embedder](#embedder) | .160 : 8788 | Bearer, timing-safe | `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN` | Recall/memory/upload-RAG embeddings fail |
| [Whisper STT](#whisper-stt) | .17 : 8788 | **none** | `WHISPER_SERVICE_URL` | Dictation → 503, typing still works |
| [Kokoro TTS](#kokoro-tts) | .17 : 8890 (lab 3744) | **none** | `TTS_SERVICE_URL` | Read-aloud → 503 |
| [Ingestor workers](#ingestor-workers) | .17, no port (pulls) | Bearer `INGEST_API_TOKEN` → app | `ASK_URL`, `INGEST_API_TOKEN`, `OLLAMA_URL` | Non-text uploads stay pending; user told "processing is down" |
| [crawl4ai](#crawl4ai) | .231 : 11235 | Bearer | `CRAWL4AI_URL`, `CRAWL4AI_API_TOKEN` | Legacy in-process JSDOM crawl (capped) |
| [FlareSolverr](#flaresolverr) | .231 (loopback only) | none | `FLARESOLVERR_URL` | Rescue-chain tier skipped (currently always) |
| [SearXNG + gluetun](#searxng-and-gluetun) | .17, via gluetun : 3741 / 3740 / 3743 | none | `SEARXNG_API_URL`, `SEARXNG_FALLBACK_API_URL` | Quality-mode search fails; other modes unaffected |
| [degoog](#degoog) | per-env stacks on .17 (stopped); public .231 : 4444 | Bearer (per-env) | `DEGOOG_ENABLED`, `DEGOOG_API_URL`, `DEGOOG_API_KEY` | Disabled everywhere |
| [Model Manager](#model-manager) | .17 : 127.0.0.1:3939 | password session | its own `.env`/`secrets.env` | Config UI unavailable only |
| [Cloudflare tunnel](#cloudflare-tunnel) | .17 Windows service | tunnel token | n/a | Public site unreachable (LAN still works) |
| [External APIs](#external-apis) | internet | API keys | see section | Each is optional except Ollama Cloud and Supabase |

## App stacks

Three copies of the same Next.js 16 app run on **.17**, one per environment. Each has its own
compose project, Postgres, Redis, SearXNG and gluetun.

| Env | Container | Host port | Compose project | Worktree / branch | Auth |
|---|---|---|---|---|---|
| prod | `ask` | 3738 | `ask-stack` | `ask-prod` / `dev` | Supabase (`ENABLE_AUTH=true`) |
| staging | `ask-admin-feature` | 3739 | `ask-stack-admin-feature` | `ask` / `admin-feature` | Supabase |
| lab | `ask-lab` | 3742 | `ask-stack-lab` | `ask-flow` / `flow-design` | **none**: `ENABLE_AUTH=false`, every request is user `lab-harness` |

- **Ports bind `0.0.0.0`** (LAN-reachable). Only prod is published to the internet, through the
  [Cloudflare tunnel](#cloudflare-tunnel). There is no router port-forward.
- **Health:** `GET /api/health` backs a Docker `HEALTHCHECK`. The fleet-boot reconcile relies on
  it (see [Fleet](/infrastructure/fleet#docker-desktop-on-17-and-the-boot-recovery-chain)).
- **Networks:** each `ask` container joins its project's default network (Postgres, Redis,
  gluetun) **and** the external `shared-infra` network. `shared-infra` was meant to reach
  loopback-bound `crawl4ai`/`flaresolverr` containers when they shared a host with the app. Since
  the app moved to .17, `shared-infra` contains only the three `ask*` containers (see
  [FlareSolverr](#flaresolverr)).
- **Boot:** the entrypoint runs `bun run migrate` under `set -e` before `next start`. A failed
  migration means the container never serves. See
  [Data layer → migrations](/infrastructure/data-layer#migrations).
- **Deploy/rebuild:** use `fleet-boot/rebuild-ask.sh {prod|staging|lab}` (build + health check
  + reclaim). See [Deploy](/operations/deploy).

## Postgres

- **Where:** per env on .17. Containers `ask-postgres`, `ask-postgres-admin-feature` and
  `ask-postgres-lab` (image `pgvector/pgvector:pg17`). **No host port is published.** Only the
  env's own compose network can reach it.
- **Auth:** password auth for two roles. The owner (`morphic`) is used by migrations and by
  `dbAdmin`. The restricted **`app_user`** (NOSUPERUSER, NOBYPASSRLS) is used by the user-facing
  runtime.
- **Config keys:** `DATABASE_URL` (owner), `DATABASE_RESTRICTED_URL` (`app_user`),
  `DATABASE_SSL_DISABLED=true`, `POSTGRES_DB`/`POSTGRES_USER`/`POSTGRES_PASSWORD`.
- **Called by:** the app (`lib/db/index.ts`) and the boot migration.
- **Failure:** the boot migration fails, so the container exits and `unless-stopped` restarts it
  in a loop. At runtime, chat persistence and history fail. If the runtime role can bypass RLS
  while `ENABLE_AUTH=true`, the app **exits on purpose** (fail-fast guard).
- Detail: [Data layer](/infrastructure/data-layer#postgres).

## Redis

- **Where:** per env on .17. Containers `ask-redis`, `ask-redis-admin-feature` and
  `ask-redis-lab` (`redis:alpine`, AOF on, `maxmemory 256mb`,
  **`maxmemory-policy noeviction`** so spend counters are never evicted). No host port.
- **Auth:** none. It's reachable only on the compose network.
- **Config keys:** `LOCAL_REDIS_URL` (`redis://redis:6379`). `UPSTASH_REDIS_REST_URL`/`_TOKEN`
  switch most helpers to Upstash REST (not used on the fleet). The resumable-stream mirror needs
  real pub/sub and only works with `LOCAL_REDIS_URL`.
- **Called by:** search caches, resumable streams, telemetry, budgets, the ingest heartbeat,
  imagegen counters and the quotes cache.
- **Failure:** every Redis use is best-effort. Caches miss. Streams stop being resumable after a
  tab switch, though the answer is still persisted. Telemetry goes to stdout only. The ingest
  heartbeat reads `null`, which counts as "unknown", not "down". Budget reads that fail skip the
  metered provider (**fail closed on spend**).
- Key families and TTLs: [Data layer → Redis](/infrastructure/data-layer#redis).

## Ollama

A native systemd service on every host (not Docker). See
[Fleet → Ollama](/infrastructure/fleet#ollama-native-systemd-on-every-host-not-docker).

| Instance | URL key | Serves |
|---|---|---|
| **.17 :11434** | `OLLAMA_BASE_URL` (all envs), `NEXT_PUBLIC_OLLAMA_BASE_URL`, prod `CLASSIFIER_OLLAMA_BASE_URL` | Cloud proxy for the **answering model** (`DEFAULT_CHAT_MODEL`, default `kimi-k2.6:cloud`) and prod's **classifier** (`CLASSIFIER_MODEL_ID=deepseek-v4-pro:cloud`). Model list, context-window lookup and vision detection. Local `qwen3-vl:4b` on the GTX 1070 for the ingestors |
| **.171 :11434** | `LOCAL_LLM_BASE_URL` | `granite4.2:8b`: title generation, memory extraction, query-expansion fallback, voice gist |
| **.231 :11434** | staging and lab `CLASSIFIER_OLLAMA_BASE_URL` (hardcoded in their overlays) | Cloud proxy for the classifier in staging and lab |

- **Auth:** none. Anything on the LAN can call it, including spending the Ollama Cloud balance.
  Cloud access works because the **daemon itself is signed in** to ollama.com, not because of a
  key in Ask.
- **Model selection:** a signed-in user's saved pick (`user_settings.preferred_chat_model`)
  outranks `DEFAULT_CHAT_MODEL` permanently, even after a model is delisted from `OLLAMA_MODELS`.
  See [Models & reasoning](/search/models-reasoning).
- **Failure modes:**
  - `.17` down means **no answers**: the classifier soft-fails (turn proceeds as "search"), then
    the answering stream errors.
  - HTTP **402** from a cloud model means the extra-usage balance is empty (for example,
    `kimi-k3:cloud`). `/api/show` still resolves the model, so only a real generation proves a
    model is usable. It fails at the first token.
  - `.171` down: titles fall back to the opening words (8 s timeout), memory extraction is
    skipped, and the expander fallback is skipped. Answers are unaffected.
  - `.231` down: staging/lab classification hits its budget (`CLASSIFIER_BUDGET_MS`, default 4 s)
    and the turn proceeds without classifier hints.

## Reranker

- **Where:** .17, container `reranker-qwen`, `0.0.0.0:8787`, on the 2080 Ti. Source and compose
  are in `/home/nightfury/selfhosted/reranker-qwen/` (FastAPI `app.py`).
- **Model:** `RERANKER_MODEL` in that directory's `.env`. It was **`Qwen/Qwen3-Reranker-8B`**
  live on 2026-09-22 (the code default and compose comments say 4B, which is stale).
- **API:** `POST /rerank {query, passages, max_length}` → `{scores}`. `max_length` defaults to
  **128** tokens (clamped 16–512), so long passages are truncated. `GET /health`.
- **Auth:** `Authorization: Bearer <RERANKER_API_TOKEN>` compared with `hmac.compare_digest`. An
  unset token returns **503** (fails closed). This is the pattern the unauthenticated services
  should copy.
- **Called by:** `lib/utils/cross-encoder.ts` (20 s timeout) from `/api/advanced-search` rerank,
  recall rerank, upload-RAG `rankChunks`, the snippet gate (off) and `lib/warm` warm-up.
- **Config keys (app):** `RERANKER_URL`, `RERANKER_API_TOKEN`, `RERANK_PASSAGE_BUDGET` (160 in
  all envs), `RERANK_COARSE_PASSAGE_BUDGET`.
- **Failure:** the cross-encoder throws, then the local bi-encoder (MiniLM cosine) takes over, then
  keyword scoring. Answers still get sources, ranked less well.
- **Management:** [Model Manager](#model-manager) can edit the reranker `.env` and restart it
  over SSH.

## Embedder

- **Where:** **.160** (NightFuryS), container `embedder`, `0.0.0.0:8788`, Quadro P4000. Source is
  in `~/selfhosted/embedder/` on .160.
- **Models loaded:** `Qwen/Qwen3-Embedding-0.6B` (1024-d) and `Xenova/all-MiniLM-L6-v2`
  (`GET /health` → `loaded`).
- **API:** `POST /embed {texts, model, kind}`, where `kind` is `query` or `document`. Queries get
  a retrieval instruction prefix.
- **Auth:** Bearer `EMBEDDING_SERVICE_TOKEN`, `hmac.compare_digest`.
- **Called by:** `lib/embeddings/transformers-embedding.ts` (30 s timeout) for **memory**,
  **conversation recall**, **upload/URL RAG** and the search dedup gate.
- **Config keys:** `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN`, `EMBEDDING_MODEL`
  (`Qwen/Qwen3-Embedding-0.6B` in all envs).
- **Failure:** `Qwen3-Embedding-0.6B` is `remoteOnly`. When the service is down, embedding
  **throws** instead of falling back to a local model, because a local approximation would poison
  the vector store. Recall and memory injection return nothing, and new uploads can't be indexed.
  Search rerank's bi-encoder tier uses local ONNX MiniLM and is unaffected.

::: danger Data-locked model
The stored `vector(1024)` rows in `user_memories` and `conversation_chunks` were produced by
Qwen3-Embedding-0.6B. Switching `EMBEDDING_MODEL` to another 1024-d model (for example
mxbai-embed-large) passes the dimension check and **silently corrupts recall**. A stale code
comment in `lib/embeddings/recall-index.ts` still suggests mxbai. Ignore it. A model change
requires a full re-embed migration.
:::

## Whisper STT

- **Where:** .17, container `ask-whisper` (`speaches-ai/speaches:latest-cuda`, digest-pinned),
  `0.0.0.0:8788` → 8000, 2080 Ti. Compose: `/home/nightfury/selfhosted/whisper/docker-compose.yml`.
- **Model:** `Systran/faster-distil-whisper-large-v3`, `int8_float16`, `WHISPER__TTL=-1`
  (always resident). The image ignores `PRELOAD_MODELS`. Fleet-boot installs the model with
  `POST /v1/models/<id>`, and the hf-cache volume keeps it across restarts.
- **API:** OpenAI-compatible `POST /v1/audio/transcriptions`.
- **Auth:** **none**. Its OpenAI-compatible API can also pull arbitrary Hugging Face models (disk
  fill). See [Security](/infrastructure/security#known-lan-exposures).
- **Called by:** `app/api/voice/transcribe` (auth required, gated by `VOICE_ENABLED`).
- **Config keys:** `WHISPER_SERVICE_URL` (`http://192.168.50.17:8788`), `VOICE_STT_MODEL`,
  `VOICE_ENABLED` (`true` in all three envs; the comment in `lib/voice/config.ts` that says
  "lab only" is stale).
- **Failure:** the route returns **503 "STT unavailable"**. The mic button fails and typing is
  unaffected.
- The **ingestor does not use this service.** It transcribes audio and video in-process with
  `faster-whisper large-v3` on CPU.

## Kokoro TTS

- **Where:** .17. `ask-tts` on `0.0.0.0:8890` serves prod and staging. `ask-tts-lab` on
  `0.0.0.0:3744` serves lab (the app reaches it by container DNS `ask-tts-lab:8880`). Both use
  `ghcr.io/remsky/kokoro-fastapi-gpu`, pinned to the **Quadro P2200** by `CUDA_VISIBLE_DEVICES`.
  Compose: `/home/nightfury/selfhosted/tts/docker-compose.yml`.
- **Auth:** **none**.
- **Called by:** `app/api/voice/speak` (auth required, `VOICE_ENABLED`).
- **Config keys:** `TTS_SERVICE_URL`, `VOICE_TTS_VOICE`, `VOICE_TTS_SPEED`, and
  `VOICE_GIST_MODEL_ID` (the gist is produced by granite on .171).
- **Failure:** **503 "TTS unavailable"**. Read-aloud fails and text is unaffected.

## Ingestor workers

- **What:** a Python worker that extracts text from office documents, media and images for
  uploads that the in-app fast path (text/PDF up to 20 MB) can't handle. It lives **outside the
  Ask repo** at `/home/nightfury/selfhosted/ingestor/` and has its own compose files.
- **Where:** .17. One per env: `ingestor` (prod), `ingestor-staging` and `ingestor-lab`. No
  published port. It **pulls** jobs from the app.
- **Auth:** it sends `Authorization: Bearer <INGEST_API_TOKEN>` to the app's `/api/ingest/*`
  routes. The token **must match** the env's app `.env`. Worker env files: prod `ingestor/.env`,
  staging `ingestor/.env.staging`, lab `ingestor/.env.lab`.
- **Config keys (worker):** `ASK_URL` (`http://192.168.50.17:{3738|3739|3742}`),
  `INGEST_API_TOKEN`, `OLLAMA_URL` (`http://host.docker.internal:11434`, the .17 Ollama),
  `VLM_MODEL=qwen3-vl:4b`, `WHISPER_MODEL=large-v3`, `MAX_VIDEO_FRAMES`, `JOB_CONCURRENCY`.
- **Flow:** `POST /api/ingest/claim` (`FOR UPDATE SKIP LOCKED`, max 3 attempts, 30-minute stale
  claim), then `GET /api/ingest/file/[id]`, then extraction (VLM captions/OCR via Ollama on the
  GTX 1070, CPU whisper for audio), then `/progress` and `/complete` with **chunk strings**. The
  **app** embeds them and writes `.chunks.json`.
- **Liveness:** the worker has no health endpoint. `claim` (idle poll every ~15 s) and `progress`
  refresh the Redis key `ingest:heartbeat` (TTL `INGEST_HEARTBEAT_TTL_S`, default 60 s).
- **Failure:** worker-path uploads stay `pending`. The answer path waits up to
  `INGEST_WAIT_TIMEOUT_MS`. If the heartbeat is stale, it tells the user processing is **down**
  instead of "still processing". A non-vision model then has no text for uploaded images. See
  [RAG & uploads](/knowledge/rag-uploads).

## crawl4ai

- **Where:** **.231**, container `crawl4ai` (`unclecode/crawl4ai:0.9.2`, pinned),
  `0.0.0.0:11235`. Config and watchdog are in `/home/nightfury/selfhosted/crawl4ai/` on .231.
  `mem_limit: 8g`, gunicorn with 8 workers, `pool.max_pages=40`.
- **Why .231:** single-thread speed. See [Fleet](/infrastructure/fleet#why-each-job-lives-where-it-does).
- **Auth:** Bearer `CRAWL4AI_API_TOKEN`. The app treats crawl4ai as configured only when both
  URL and token are set.
- **Called by:** `/api/advanced-search` enrichment (`crawl4aiScrapeMany`, chunks of
  `CRAWL4AI_CHUNK_SIZE`=8, up to `CRAWL4AI_MAX_CONCURRENT_CHUNKS`=6 in flight, 60 s per chunk) and
  the `fetch` tool's rescue chain.
- **Config keys:** `CRAWL4AI_URL`, `CRAWL4AI_API_TOKEN`, `MAX_ENRICH_URLS`,
  `CRAWL4AI_CHUNK_SIZE`, `CRAWL4AI_MAX_CONCURRENT_CHUNKS`.
- **Failure:** pages fall back to the **legacy in-process crawler** (Readability + JSDOM, 20 s
  deadline). On a total crawl4ai outage that fallback is **capped at 8 URLs**, because many
  synchronous JSDOM parses stall the Node event loop for everyone.
- **Known issue: memory creep.** The container's own memory guard reads the **host's** RAM
  (psutil isn't cgroup-aware), so it never fires before the 8 GiB OOM. Symptoms are
  `Crawl4AI HTTP 500` and `slowest_chunk_ms` of ~125 s in `[latency:search]`. A cron job on .231
  (`*/15`, `crawl4ai/memory-watchdog.sh`) restarts it above 80 % of its cgroup limit. When
  retrieval is slow, check `docker stats --no-stream crawl4ai` on .231 first.

::: warning Staging points at an unresolvable crawl4ai
`docker-compose.admin-feature.yaml` hardcodes `CRAWL4AI_URL: 'http://crawl4ai:11235'`. That name
resolved on .231 through `shared-infra` but **does not resolve on .17**. Compose `environment:`
beats `.env`, so staging ignores the correct `.env` value (`http://192.168.50.231:11235`), and
every staging crawl falls back to the capped legacy crawler. Fix: drop the override in the
`ask` worktree's overlay (or set it to the .231 URL), then rebuild staging. Prod and lab are
correct.
:::

## FlareSolverr

- **Intended role:** the rescue-chain tier for Cloudflare-style bot walls, between crawl4ai and
  Tavily/Firecrawl in `lib/tools/fetch.ts`.
- **Where:** .231, container `flaresolverr`, bound to **`127.0.0.1:8191`** only.
- **Config key:** `FLARESOLVERR_URL=http://flaresolverr:8191` in all envs.
- **Current state:** on .17 the hostname `flaresolverr` **does not resolve** (it isn't on .17's
  `shared-infra`), and the .231 container is loopback-bound. **This tier fails immediately in
  every env**, and the chain moves on to Jina/Tavily/Firecrawl. It is harmless but dead weight.
  To revive it, run FlareSolverr on .17 attached to `shared-infra`.

## SearXNG and gluetun

- **Where:** .17, per env: `ask-searxng`, `ask-searxng-admin-feature` and `ask-searxng-lab`. Each
  runs **inside its gluetun container's network namespace** (`network_mode: service:gluetun`).
  The gluetun containers (`ask-gluetun`, `ask-gluetun-admin-feature`, `ask-gluetun-lab`) run
  Mullvad WireGuard with the kill-switch on, and publish the SearXNG UI on **3741** (prod),
  **3740** (staging) and **3743** (lab).
- **Why the VPN:** the residential IP is flagged, so Brave, Startpage and Google CSE rate-limited
  or CAPTCHA'd it. **Only SearXNG** goes through the VPN. The app, database, crawler and model
  hosts keep LAN egress. Prod pins one Mullvad server. `fleet-boot/rotate-daily.sh` (cron 05:00)
  rotates exits and clears the engine-health suspensions. Two stacks must **never share a Mullvad
  server hostname**, because the same account key fights over the route.
- **Settings:** `searxng-settings.yml` (prod) and `searxng-settings.admin-feature.yml`
  (staging), in each worktree. The engines Ask requests include bing, duckduckgo and google cse.
  Ask suspends failing engines by name for 30 minutes (`lib/search/engine-health.ts`, Redis
  `enginehealth:*`).
- **Auth:** none. The UI port is an open search proxy for the LAN (see Security).
- **Called by:** `/api/advanced-search` in **quality** mode only (balanced and speed skip
  SearXNG), the basic `search` path and `/api/discover`.
- **Config keys:** `SEARXNG_API_URL` (`http://ask-gluetun[-env]:8080`),
  `SEARXNG_FALLBACK_API_URL`, `SEARXNG_CRAWL_MULTIPLIER`, `SEARXNG_DEFAULT_DEPTH`,
  `MULLVAD_*` (in `.env`).
- **Failure:** SearXNG is the one hard dependency of **quality** mode: its rejection throws. A
  circuit breaker would fail over to `SEARXNG_FALLBACK_API_URL`, but that value
  (`http://searxng:8080` in prod and staging, empty in lab) **doesn't resolve on .17**, so there
  is effectively **no fallback**. Cold boot can wedge gluetun, which fleet-boot's
  `ensure_vpn_search` repairs.

::: tip Three different SearXNGs
- **Public SearXNG** is `search.hbqnexus.win`: container `searxng` on .231 behind
  `searxng-gluetun` `:8127`, settings `/home/nightfury/selfhosted/searxng/settings.yml`. It's the
  owner's personal instance and **Ask must never point at it**. (`NEXT_PUBLIC_SEARXNG_URL` names it
  only for UI links.)
- **Prod ask SearXNG** is `ask-searxng`.
- **Staging ask SearXNG** is `ask-searxng-admin-feature`.

Say which one you mean. Mixing them up has sent engine changes to the wrong instance before.
:::

## degoog

- **Per-env stacks:** `degoog-prod` (:4445), `degoog-staging` (:4446) and `degoog-lab` (:4447).
  They moved from .231 to .17 on 2026-09-07 and are **stopped**. `DEGOOG_ENABLED=false` in every
  env, so quality mode doesn't query degoog (SearXNG covers it). To re-enable one env: `docker
  compose up -d` that degoog project, set `DEGOOG_ENABLED=true`, rebuild the app, and uncomment
  `ensure_degoog` in `ask-fleet-boot.sh`. Keys: `DEGOOG_API_URL`
  (`http://degoog-gluetun-<env>:4444`), `DEGOOG_API_KEY` (Bearer). Client timeout 8 s. It fails
  open.
- **Public degoog on .231 :4444** (compose project `degoog`, `/home/nightfury/selfhosted/degoog`,
  behind `degoog-gluetun`) is the owner's **personal/public instance** and has **human
  consumers**.

::: danger Never decommission degoog :4444
No Ask container references `:4444`, and there's no proxy or tunnel config for it. Neither fact
proves nothing uses it. It was once stopped as "orphaned" and real users noticed. Container-env
greps can't see a browser, a bookmark or an external client. Don't stop any published port on the
strength of a "nothing references it" check. Restart with
`cd /home/nightfury/selfhosted/degoog && docker compose -f docker-compose.yaml -f docker-compose.vpn.yaml start`.
:::

## Model Manager

- **What:** the "Ask Model Manager", a separate Next.js app for editing prod's `.env` (with
  automatic backups), recreating the prod `ask` service, and editing the reranker's `.env` and
  restarting it over SSH. Its "add a model" feature just edits the `OLLAMA_MODELS` list.
- **Where:** .17, container `model-manager`, **`127.0.0.1:3939`** (loopback only). Source is at
  `ask/selfhosted/model-manager/` (nested in the staging worktree), with its own compose file.
  Reach it from a laptop with `ssh -L 3939:localhost:3939 nightfury@192.168.50.17`.
- **Auth:** a password login (`MODEL_MANAGER_PASSWORD` in `secrets.env`) creates a session
  cookie. The session is checked in middleware **and** per handler on `/api/apply`
  (unauthenticated → 401).
- **Privilege:** **root-equivalent.** It mounts `/var/run/docker.sock`, the prod worktree
  read-write and an SSH key. Never expose it beyond loopback.
- **Wiring (important):** `ASK_REPO_DIR` and `ASK_ENV_PATH` point at **`ask-prod`**,
  `ASK_COMPOSE_PROJECT=ask-stack`, and `ASK_COMPOSE_FILES` lists base + `docker-compose.vpn.yaml`.
  `apply` runs `docker compose -p ask-stack -f … up -d --force-recreate --no-deps --wait ask`,
  the exact prod deploy command. An earlier miswiring (single `-f`, no `-p`, staging worktree)
  recreated **prod from staging's `.env`** on every apply. If you touch this, check
  `docker inspect ask --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`.
- **Reranker target:** `RERANKER_SSH_TARGET=nightfury@192.168.50.17`,
  `RERANKER_REMOTE_DIR=/home/nightfury/selfhosted/reranker-qwen`. Edits are read-modify-write so
  `RERANKER_API_TOKEN` survives.
- **Other keys:** `MODEL_MANAGER_SESSION_SECRET`. If unset, the session secret is derived from
  the password; set it explicitly.
- **Failure:** only the config UI is affected. Edit `.env` by hand and recreate instead.

## Cloudflare tunnel

- **Where:** `cloudflared` runs as a **Windows service on .17** (`AUTO_START`,
  `cloudflared.exe tunnel run --token …`). It isn't in WSL or Docker. Ingress rules live in the
  **Cloudflare dashboard** (token-based tunnel), mapping `ask.hbqnexus.win` → `localhost:3738`.
- **Separate tunnel on .231:** a host `cloudflared` there serves the owner's other sites (public
  search etc.). It **no longer** serves Ask.
- **Auth:** the tunnel token (outbound-only connection). There are no inbound ports and no port
  forward. Prod still enforces its own Supabase auth.
- **Headers:** the app reads the visitor IP from `CF-Connecting-IP` / `X-Forwarded-For` (used by
  `/api/geolocate` and the guest rate limiter). App egress itself is **not** on the VPN.
- **Failure:** the public site is down. LAN access to `:3738` still works. Check
  `sc.exe query cloudflared` from Windows (or `/mnt/c/Windows/System32/sc.exe query cloudflared`
  from WSL).

## External APIs

### Ollama Cloud

- The answering model (`DEFAULT_CHAT_MODEL`, `OLLAMA_MODELS` roster) and the classifier
  (`CLASSIFIER_MODEL_ID=deepseek-v4-pro:cloud`, all envs) are **Ollama Cloud models reached
  through a signed-in local Ollama daemon**. This is the only "cloud model" source Ask uses.
- **Ollama web search:** `https://ollama.com/api/web_search`, called directly with
  `OLLAMA_SEARCH_API_KEY`. It's used by speed mode (the only source) and balanced/quality
  (prefetched, no crawl). `OLLAMA_SEARCH_ENABLED=off` disables it.
- **Failure:** see [Ollama](#ollama). A 402 means the extra-usage balance is empty. That's a
  billing state, not a code bug.

### Search APIs

Metered providers, fired in balanced and quality modes, each behind a Redis budget that **fails
closed** (a failed budget read skips the provider):

| Provider | Key | Budget key / default | Notes |
|---|---|---|---|
| Tavily | `TAVILY_API_KEY` | `tavily:budget:YYYY-MM` | Also Tavily Extract in the `fetch` rescue chain |
| Brave | `BRAVE_SEARCH_API_KEY` | `brave:budget:YYYY-MM`, `BRAVE_MONTHLY_BUDGET` (2000) | Top `BRAVE_CRAWL_MAX`=3 results are crawled, the rest are prefetched |
| LangSearch | `LANGSEARCH_API_KEY` | `langsearch:budget:YYYY-MM-DD`, `LANGSEARCH_DAILY_BUDGET` (900) | `LANGSEARCH_TIMEOUT_MS`=2500 |
| Firecrawl | `FIRECRAWL_API_KEY` | none | Last tier of the `fetch` rescue chain (1 credit per scrape) |
| Jina Reader | none (`r.jina.ai`) | none | `fetch` rescue tier |

The keys are shared across prod/staging/lab, so the monthly budgets are counted **per env**
against one shared account quota.

### Supabase Auth

- A hosted Supabase project provides authentication for prod and staging. Keys:
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (browser) and
  `SUPABASE_SECRET_KEY` (server admin client).
- The server verifies sessions with `supabase.auth.getUser()` (a round-trip to Supabase), never
  the unverified `getSession()`. The middleware (`proxy.ts` → `lib/supabase/middleware.ts`)
  refreshes the session cookie.
- **Failure:** prod and staging users can't sign in, and signed-in requests resolve to no user.
  Guest chat is off (`ENABLE_GUEST_CHAT` unset), so the chat is unusable. Lab doesn't depend on
  Supabase.

### Replicate

- Image generation and editing (`generateImage` tool), offered only when `REPLICATE_API_TOKEN` is
  set **and** the user is authenticated. `REPLICATE_IMAGE_EDIT_MODEL` pins the edit model.
  `REPLICATE_MONTHLY_BUDGET` enables a fail-closed Redis spend cap (`replicate:budget:YYYY-MM`).
- **Failure:** the tool errors and the answer explains. There's no fallback provider.

### Other public APIs

| API | Used by | Key |
|---|---|---|
| Open-Meteo (forecast + geocoding) | `get_weather` tool, `/api/weather` | none |
| Nominatim (OpenStreetMap) | `/api/geocode` (weather location search) | none |
| ipapi.co | `/api/geolocate` (IP fallback for the weather widget) | none |
| Langfuse | optional tracing and feedback scoring | `LANGFUSE_*` (unset on the fleet) |
| Couchbase (LAN) | `/api/quotes` homepage quotes pool, cached 24 h in Redis `quotes:pool` | `COUCHBASE_URL` + credentials |
