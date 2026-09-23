---
title: Local development
---

# Local development

Ask is developed against real infrastructure: the day-to-day loop is to edit code in
the **lab worktree** (`/home/nightfury/selfhosted/ask-flow`, branch `flow-design`) and
rebuild the lab container (`:3742`). The lab runs with auth off and its own database,
so it can be driven freely from a browser or a script. A bare `bun dev` on a laptop is
possible but needs its own Postgres/Redis and does not reach the fleet the same way.

## Toolchain

| Tool | Version in use | Notes |
|---|---|---|
| bun | 1.3.14 (pinned in the `Dockerfile`) | Package manager **and** script runner. Lockfile is `bun.lock`. |
| Node.js | 22.x in the image (`FROM node:22-slim`); `package.json` `engines.node` is `22.x` | The app host currently has Node 20 installed; tests and typecheck run fine on it, but production parity is Node 22 inside the container. |
| Next.js | 16.2.x (`next` `^16.2.6`) | `proxy.ts` is Next 16's replacement for `middleware.ts`. |
| Docker + Compose | Docker 29, Compose v5 on the app host (Docker Desktop with the WSL2 backend) | All three environments are compose projects on the same host. |
| TypeScript | 5.x | `bun run typecheck` |
| Vitest | 4.x | `bun run test` — **not** `bun test` (see below). |

## Repo commands (`package.json` scripts)

| Command | What it does |
|---|---|
| `bun dev` | `next dev` on http://localhost:3000 (Turbopack). |
| `bun run build` / `bun start` | Production build / serve. The container runs `npx next start -H 0.0.0.0` after migrations. |
| `bun run lint` | ESLint (includes `simple-import-sort`). Currently 0 errors, 5 warnings (`<img>` usage). |
| `bun run typecheck` | `tsc --noEmit`. Currently clean. |
| `bun run format` / `format:check` | Prettier write / check. |
| `bun run migrate` | Applies Drizzle migrations from `drizzle/` using `DATABASE_URL` (`lib/db/migrate.ts`). Also runs automatically at container start. |
| `bun run test` / `test:watch` | Vitest with `NODE_ENV=test`. |
| `bun run chat` | CLI client for `/api/chat` (`scripts/chat-cli.ts`; localhost only; needs a session cookie in `.env.local` for authed stacks). |
| `bun run eval` / `eval:mine` | Answer-quality eval harness (`scripts/eval/run-eval.ts`) and question mining from prod history. See [Testing & QA](/operations/testing-qa). |
| `bun run backfill:file-keys` | One-off backfill of private file object keys (`scripts/backfill-file-object-keys.ts`). |
| `bun run clean:narration` | One-off cleanup of stored narration preambles (`scripts/clean-narration-preambles.ts`). |

::: warning `bun test` is the wrong command
`bun test` runs bun's built-in test runner, which ignores `vitest.config.mts` (aliases,
jsdom, setup file) and produces a wall of spurious failures. Always use
`bun run test`.
:::

## Running each environment

All three stacks live on the app host **NightFuryX (192.168.50.17)**, each built from its
own worktree. The one command to (re)build any of them is:

```bash
/home/nightfury/selfhosted/ask-flow/fleet-boot/rebuild-ask.sh lab      # :3742
/home/nightfury/selfhosted/ask-flow/fleet-boot/rebuild-ask.sh staging  # :3739
/home/nightfury/selfhosted/ask-flow/fleet-boot/rebuild-ask.sh prod     # :3738
```

The script `cd`s into the right worktree, passes the right `-f` files and `-p` project,
waits for HTTP 200, then reclaims Docker disk space (`fleet-boot/rebuild-ask.sh`).
Details, including why it must run in the foreground, are in [Deploy](/operations/deploy).

To bring a stack up without rebuilding (e.g. after an `.env` change), use the full file
set from the table in [Environments](/operations/environments#compose-projects), e.g. for the lab:

```bash
cd /home/nightfury/selfhosted/ask-flow
docker compose -p ask-stack-lab \
  -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml \
  up -d --force-recreate ask
```

::: danger Never run a bare `docker compose up` in any worktree
The base `docker-compose.yaml` declares `name: ask-stack` and `container_name: ask` —
that **is production**. Running `docker compose up -d --build` with only the base file,
from *any* worktree (including the lab), rebuilds and replaces the prod container with
that worktree's code and `.env`. Always pass the environment's full `-f` list and `-p`
project, or use `rebuild-ask.sh`.
:::

### Running `next dev` directly (optional)

The README's generic flow still works for UI-only work:

```bash
bun install
cp .env.local.example .env.local   # then fill in values
bun dev
```

Caveats *(this path is not part of the regular workflow and is only partly verified)*:

- No stack publishes Postgres or Redis ports to the host (`5432`/`6379` are
  container-internal), so `next dev` needs its own database, e.g. a throwaway
  `pgvector/pgvector:pg17` container with a published port, then `bun run migrate`.
- Service URLs in the stacks' `.env` files use container DNS names (`postgres`,
  `redis`, `ask-gluetun`) that do not resolve from the host; use the LAN IPs instead.
- Set `ENABLE_AUTH=false` for a local single-user session (see
  `lib/auth/get-current-user.ts`).

## Environment files

| File | Tracked? | Purpose |
|---|---|---|
| `.env` | **No** (gitignored, mode 0600) — one per worktree | Runtime config and secrets for that stack. Loaded by compose `env_file: .env`, and also copied into the build context so `next build` can inline `NEXT_PUBLIC_*` values. |
| `.env.local.example` | Yes | Template listing every supported variable with comments. There is no `.env.example` in this repo. |
| `.env.local` | No | Only for a bare `bun dev`; ignored by the containers. |
| `.env.bak.*`, `.env.bak-*`, `.env.tmp.*` | No | Backups written by the Model Manager and by key-rotation scripts. |
| `docker-compose*.yaml` `environment:` | Yes | Per-env overrides; these **win** over `.env` for the same variable. |

Variable **names** currently present in the lab `.env` (values are secrets or
host-specific and are intentionally not reproduced here):
`HOST_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `OLLAMA_BASE_URL`,
`OLLAMA_MODELS`, `DEFAULT_CHAT_MODEL`, `CLASSIFIER_OLLAMA_BASE_URL`, `CLASSIFIER_MODEL_ID`,
`LOCAL_LLM_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_SERVICE_URL`, `EMBEDDING_SERVICE_TOKEN`,
`RERANKER_URL`, `RERANKER_API_TOKEN`, `RERANK_PASSAGE_BUDGET`, `SEARCH_API`,
`SEARXNG_API_URL`, `SEARXNG_FALLBACK_API_URL`, `SEARXNG_SECRET`, `NEXT_PUBLIC_SEARXNG_URL`,
`CRAWL4AI_URL`, `CRAWL4AI_API_TOKEN`, `FLARESOLVERR_URL`, `FIRECRAWL_API_KEY`,
`DEGOOG_API_URL`, `DEGOOG_API_KEY`, `NEXT_PUBLIC_OLLAMA_BASE_URL`, `BASE_URL`,
`ENABLE_AUTH`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `DATABASE_RESTRICTED_URL`, `OLLAMA_SEARCH_API_KEY`,
`TAVILY_API_KEY`, `TAVILY_MERGE_ENABLED`, `TAVILY_MONTHLY_BUDGET`, `BRAVE_SEARCH_API_KEY`,
`LANGSEARCH_API_KEY`, `REPLICATE_API_TOKEN`, `MEMORY_CRON_SECRET`, `INGEST_API_TOKEN`,
`UPLOAD_TTL_DAYS`, `SEARCH_EXCERPTS_ENABLED`, `COUCHBASE_URL`, `COUCHBASE_USERNAME`,
`COUCHBASE_PASSWORD`, `MULLVAD_PRIVATE_KEY`, `MULLVAD_ADDRESSES`, `MULLVAD_COUNTRY`,
`NEXT_PUBLIC_VOICE_ENABLED`.

The full catalogue — every variable the code reads, where, and its default — is the
generated [Env flags reference](/reference/env-flags).

::: warning `NEXT_PUBLIC_*` needs a rebuild, everything else needs a recreate
- `NEXT_PUBLIC_*` values are inlined into the client bundle by `next build`. Changing
  one in `.env` does nothing until the image is **rebuilt** (`rebuild-ask.sh`). Setting
  one in a compose `environment:` block is too late for the bundle (see the comment in
  `docker-compose.lab.yaml:180-185`).
- Server-side variables are read at container start. After editing `.env`, recreate
  the container: `docker compose … up -d --force-recreate ask` (or use the Model Manager
  for prod — see [Deploy](/operations/deploy#env-only-changes)).
:::

::: danger Grepping `.env` leaks secrets
Token lines match innocent-looking greps (`grep -i crawl` returns `CRAWL4AI_API_TOKEN`;
`grep -i reranker` returns `RERANKER_API_TOKEN`). Decide the mask **before** running the
command: grep an exact key (`grep '^RERANKER_URL='`), list names only
(`grep -oE '^[A-Z_][A-Z0-9_]*=' .env`), or pipe through `sed -E 's/=.*/=<redacted>/'`.
The same applies to `docker exec <c> printenv` and `docker inspect … .Config.Env`.
:::

## How the app reaches fleet services

The app container talks to two kinds of dependency: **same-stack containers** by
compose DNS name, and **shared fleet services** by LAN IP. Current runtime values (read
from the running containers with `docker exec <c> printenv <NAME>`):

| Dependency | Env var | Prod value | Notes |
|---|---|---|---|
| Postgres | `DATABASE_URL`, `DATABASE_RESTRICTED_URL` | `postgres:5432` (container DNS) | Runtime uses the restricted `app_user` role so RLS is enforced; migrations use the owner. See [Data layer](/infrastructure/data-layer). |
| Redis | `LOCAL_REDIS_URL` | `redis://redis:6379` | Set in base compose. |
| SearXNG | `SEARXNG_API_URL` | `http://ask-gluetun:8080` | SearXNG lives inside the gluetun VPN container's network namespace, so it is addressed by the **gluetun** name. Staging: `ask-gluetun-admin-feature`; lab: `ask-gluetun-lab`. |
| Ollama (answering models, cloud proxy) | `OLLAMA_BASE_URL` | `http://192.168.50.17:11434` | Native Ollama on the app host; `*:cloud` models are forwarded to Ollama Cloud. |
| Classifier | `CLASSIFIER_OLLAMA_BASE_URL`, `CLASSIFIER_MODEL_ID` | prod `.17:11434`; staging/lab overlays pin `.231:11434` | Model is `deepseek-v4-pro:cloud` in all three. |
| Local small LLM (titles, memory extraction, expander fallback) | `LOCAL_LLM_BASE_URL` | `http://192.168.50.171:11434` | granite on Serenity's P5000. |
| Cross-encoder reranker | `RERANKER_URL` (+ token) | `http://192.168.50.17:8787` | |
| Embedder | `EMBEDDING_SERVICE_URL` (+ token) | `http://192.168.50.160:8788` | Data-locked to the `vector(1024)` columns — never swap the model without a re-embed. |
| crawl4ai | `CRAWL4AI_URL` (+ token) | `http://192.168.50.231:11235` | Lab same; **staging's overlay pins `http://crawl4ai:11235`** — see the warning below. |
| FlareSolverr | `FLARESOLVERR_URL` | `http://flaresolverr:8191` | See warning below. |
| TTS (Kokoro) | `TTS_SERVICE_URL` | `http://192.168.50.17:8890` | Lab uses its own `ask-tts-lab:8880`. |
| STT (Whisper) | `WHISPER_SERVICE_URL` | `http://192.168.50.17:8788` | |

The authoritative map of hosts and ports is [Services](/infrastructure/services).

::: warning Container-name URLs from the old host no longer resolve
Before the 2026-08-23 migration the stacks ran on MiniNightFury (.231), where
`crawl4ai` and `flaresolverr` were containers on the external `shared-infra` Docker
network. On the current app host, `shared-infra` contains only the three app
containers, and `getent hosts crawl4ai` / `getent hosts flaresolverr` return nothing
from inside `ask` or `ask-admin-feature` (checked 2026-09-22). Consequences:
- **Staging's** `CRAWL4AI_URL: 'http://crawl4ai:11235'`
  (`docker-compose.admin-feature.yaml` in the `ask` worktree) cannot reach crawl4ai;
  staging's advanced search falls back to the in-process crawler.
- `FLARESOLVERR_URL=http://flaresolverr:8191` (all envs, from `.env`) is unreachable,
  so that step of the `fetch` tool's rescue chain is skipped. FlareSolverr runs on .231
  bound to `127.0.0.1` only.
These fail open, so nothing errors visibly; they are listed in
[Known issues](/history/known-issues).
:::

## Common pitfalls

| Pitfall | Symptom | Avoid it by |
|---|---|---|
| Bare `docker compose up` in a worktree | Prod container replaced with the wrong code/`.env` | Always `rebuild-ask.sh` or the full `-p`/`-f` set. |
| Untracked files in a worktree | They ship in that stack's image — the Dockerfile does `COPY . .` and `.dockerignore` excludes only `selfhosted/`, `.superpowers/`, `.claude/`, `.git/`, `docs-site/` | Keep worktrees clean before building staging/prod. |
| Editing the lab's copy of another env's overlay | No effect: staging runs from `/home/nightfury/selfhosted/ask`, prod from `/home/nightfury/selfhosted/ask-prod` | Edit the file in the worktree that env actually builds from; verify with `docker exec <c> printenv`. |
| Trusting a code default | e.g. the classifier's code default is a local granite model, but every env overrides it | Read the running container's env, not `?? 'default'` in code. |
| Changing the classifier model | Needs the prod `.env` **and** the staging/lab overlays (they hardcode `CLASSIFIER_MODEL_ID`; `environment:` wins over `.env`) | Change all three places. |
| `.env` edited, nothing changed | Container not recreated | `up -d --force-recreate ask`. |
| `NEXT_PUBLIC_*` edited, nothing changed | Build-time value | Rebuild. |
| Tests time out after 5 s on the host | Some modules try a real Redis connection to `localhost:6379`, which is not reachable from the host | Known; see [Testing & QA](/operations/testing-qa#pre-existing-failures). |
| Browser geolocation / mic silently fail | `Permissions-Policy` header in `next.config.mjs` must keep `geolocation=(self)` and `microphone=(self)` | Check the header first: `curl -sI https://ask.hbqnexus.win/ \| grep -i permissions-policy`. |
| Diagnosing search with test queries | Trips engine rate limits / bot detection on the shared VPN exits | Read logs and existing telemetry instead; see [Testing & QA](/operations/testing-qa#no-live-search-probing). |
