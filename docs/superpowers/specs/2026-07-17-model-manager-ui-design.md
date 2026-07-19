# Model-manager UI for Ask

**Date:** 2026-07-17
**Status:** Design — pending user review, then implementation plan
**Goal:** A standalone web UI that manages Ask's entire `.env` configuration —
especially the model/service planes (chat models, the classifier/expander/
extractor on serenity, embeddings, and the reranker on nightfuryS) — so that
config no longer has to be hand-edited. It writes `.env`, restarts the
affected containers (locally and cross-host), and validates hosts/models
before applying. Once it is live, Ask's own read-only Models settings tab is
removed.

## Context

Ask's model and service configuration is driven entirely by env vars in
`/home/nightfury/selfhosted/ask/.env`, loaded into the `ask` container via
docker-compose `env_file`. Nothing writes that file today; it is read once at
container start, so any change requires an `ask` restart. There are three
independent model "planes," each wired differently:

1. **Chat / answer models.** `OLLAMA_BASE_URL` (`http://192.168.50.231:11434`)
   - `OLLAMA_MODELS` (a static comma-separated list of cloud models that do
     not appear in `/api/tags`). The selectable list is built live by
     `lib/models/fetch-models.ts`; the _chosen_ model is a `selectedModel`
     cookie. Cloud provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
     `GOOGLE_GENERATIVE_AI_API_KEY`, `AI_GATEWAY_API_KEY`,
     `OPENAI_COMPATIBLE_*`) live in `lib/utils/registry.ts` — presence of a key
     toggles that provider.
2. **Auxiliary models on serenity** (`192.168.50.171`). Host is env-driven
   (`CLASSIFIER_OLLAMA_BASE_URL`, falling back to `OLLAMA_BASE_URL`), consumed
   by `lib/agents/query-classifier.ts`, `query-expander.ts`, and
   `memory-extractor.ts`. **The model name `granite4.1:8b` is hardcoded in
   source** (`CLASSIFIER_MODEL_ID` at `query-classifier.ts:29`,
   `EXPANDER_MODEL_ID` at `query-expander.ts:15`), not env-driven.
3. **Embeddings + reranker.** `EMBEDDING_MODEL`
   (`mixedbread-ai/mxbai-embed-large-v1`, an allowlist of 3 in
   `lib/embeddings/transformers-embedding.ts`) plus the cross-encoder reranker
   at `RERANKER_URL` (`http://192.168.50.160:8787`, nightfuryS/P4000) with
   `RERANKER_API_TOKEN`. **The reranker model
   (`RERANKER_MODEL=BAAI/bge-reranker-v2-m3`) is set in the reranker's own
   compose on nightfuryS** (`selfhosted/reranker/docker-compose.yaml`), a
   separate container on a separate host — not in Ask's `.env`.

The long tail of `.env` (Search: `SEARXNG_*`, `CRAWL4AI_*`, `FLARESOLVERR_URL`,
`FIRECRAWL_API_KEY`, `DEGOOG_*`, `TAVILY/EXA/BRAVE/JINA` keys,
`OLLAMA_SEARCH_*`; Database: `DATABASE_URL`, `POSTGRES_*`; Auth:
`ENABLE_AUTH`, `SUPABASE_*`, `ANONYMOUS_USER_ID`; Memory/recall tuning:
`MEMORY_*`, `RECALL_*`; Storage: R2/S3; Infra: `HOST_PORT`, `BASE_URL`,
Redis, PostHog, Langfuse, `MEMORY_CRON_SECRET`, `MODEL_CACHE_DIR`) is also in
scope, because the tool manages _every_ var, not just model ones.

Three facts drive the whole design:

- Config is env-only and read at container start → any change needs a
  restart.
- Two model names are not env-driven yet (the serenity classifier/expander
  name in Ask's source, the reranker name in nightfuryS's compose) → two
  one-time enabling changes.
- The reranker is a separate service on a separate host → cross-host restart.

## Decisions (from brainstorming)

- **Apply model:** edit **and** one-click apply. The tool writes `.env` and
  restarts the affected containers itself. It needs Docker socket access
  (local) and SSH access (nightfuryS).
- **Serenity model names:** make them env-driven via a one-time,
  behavior-preserving change to Ask's source.
- **Reranker scope:** full cross-host control — the tool reaches nightfuryS to
  change `RERANKER_MODEL` and restart the reranker container.
- **Config scope:** fully structured — every `.env` var gets a typed field,
  grouped by category, with help text and validation.
- **Build approach:** a standalone Next.js app reusing Ask's stack, cleanly
  isolated (no code imports from Ask; the only shared contract is the `.env`
  file plus docker/ssh commands).

## Architecture & isolation

A standalone Next.js app (shadcn/ui, Tailwind, TypeScript, bun — the same
stack as Ask, so the structured form costs almost no UI-building effort) with
**zero code imports from Ask**.

- **Location:** `ask/selfhosted/model-manager/` — a sibling to
  `selfhosted/reranker/`. This keeps it in the Ask git repo (so the existing
  push-to-prod flow versions it) while remaining a fully separate app and
  container. (Alternative: a wholly separate repo — a one-line change to where
  it lives if preferred later.)
- **Runtime:** its own container in the compose stack, published on a LAN port
  (e.g. `3939`). It mounts four things:
  1. Ask's `.env` (read-write).
  2. Ask's compose file + repo dir (to recreate the `ask` service).
  3. The Docker socket (or docker CLI).
  4. A dedicated, restricted SSH key to reach nightfuryS.
- **Cross-host reach:** for the reranker, it SSHes to nightfuryS with the
  restricted key and runs `docker compose up -d reranker`. (Alternative: a
  remote Docker context — but SSH is simpler and LAN SSH already exists.)

### Two one-time enabling changes to existing services

Both are done once, are behavior-preserving, and keep today's values as
defaults so nothing changes until the UI edits them:

1. **Ask source** — replace the hardcoded model-id constants with env
   fallbacks:
   ```ts
   const CLASSIFIER_MODEL_ID =
     process.env.CLASSIFIER_MODEL_ID ?? 'granite4.1:8b'
   const EXPANDER_MODEL_ID = process.env.EXPANDER_MODEL_ID ?? 'granite4.1:8b'
   const MEMORY_EXTRACTOR_MODEL_ID =
     process.env.MEMORY_EXTRACTOR_MODEL_ID ?? 'granite4.1:8b'
   ```
   in `query-classifier.ts`, `query-expander.ts`, `memory-extractor.ts`.
2. **Reranker service** — move `RERANKER_MODEL` out of the compose
   `environment:` block in `selfhosted/reranker/docker-compose.yaml` and into
   the reranker's own `.env` (same default, `BAAI/bge-reranker-v2-m3`), so the
   tool can edit it over SSH and restart the reranker.

## Env-schema registry (data model)

One typed catalog (a TS array) is the single source of truth. It drives the
form, grouping, validation, which restart a change triggers, and which fields
get a Test button. Adding a var later is one array entry.

```ts
interface EnvVarSpec {
  key: string // 'OLLAMA_BASE_URL'
  category:
    | 'models'
    | 'search'
    | 'database'
    | 'auth'
    | 'memory'
    | 'storage'
    | 'infra'
  group?: string // sub-group, e.g. 'Chat', 'Serenity', 'Embeddings', 'Reranker'
  label: string // 'Chat host'
  type:
    | 'url'
    | 'model'
    | 'model-list'
    | 'secret'
    | 'bool'
    | 'int'
    | 'enum'
    | 'string'
  help?: string
  default?: string // shown as a hint
  required?: boolean
  enumValues?: string[] // e.g. EMBEDDING_MODEL's 3-model allowlist, SEARCH_API
  validate?: (v: string) => string | null // returns error message or null
  target?: 'ask' | 'reranker' // which host/file — defaults to 'ask'
  testable?: 'ollama' | 'reranker' | 'http' // enables a Test button
}
```

- **`target`** decides which container a change restarts and which file it is
  written to. Almost every var is `target: 'ask'` (Ask's `.env`, local
  restart). `RERANKER_MODEL` is `target: 'reranker'` (nightfuryS's `.env`,
  remote restart). The Ask-side reranker vars (`RERANKER_URL`,
  `RERANKER_API_TOKEN`) stay `target: 'ask'`.
- **Model lists** (`OLLAMA_MODELS`, `OPENAI_COMPATIBLE_MODELS`) use
  `type: 'model-list'` — an editable, reorderable row list (add / remove /
  drag), serialized back to a comma-separated value. This is the "add more and
  change them around" capability. Assigning "which model does which job"
  (classifier, embeddings, etc.) is simply editing that job's field.
- **`testable`** enables a per-field connection test (see below).

## The `.env` engine

Parses `.env` into an ordered token list that **preserves comments, blank
lines, ordering, and any keys not in the registry** (passed through untouched
— the tool never clobbers a var it does not know). Editing updates a value in
place; values needing quotes are quoted. On the rare occasion a registry key
is absent from the file, it is appended under its category section.

- **Atomic writes:** write to a temp file, then rename.
- **Backups:** every write is preceded by a timestamped backup
  (`.env.bak.<ts>`); the last N are kept and listed in the UI for one-click
  restore.
- **Diff before apply:** before anything is written or restarted, the UI shows
  a unified diff of exactly what changed, with **secrets masked**. Nothing
  happens until that diff is confirmed.

## Apply orchestration

After the masked diff is confirmed:

1. Back up `.env`.
2. Atomic-write the new `.env`.
3. Inspect the `target` of every changed var to decide restarts:
   - Any **Ask** var changed → recreate `ask` locally:
     `docker compose up -d ask` (force-recreate so new env is picked up).
   - **`RERANKER_MODEL`** changed → SSH nightfuryS: write the reranker's
     `.env`, then `docker compose up -d reranker`. A model change
     re-downloads/loads weights (slow), so the health-wait honors the
     service's 120s `start_period`.
   - Reranker URL/token are Ask-side, so they only trigger the `ask` restart.
4. **Health-wait** with live status
   (`backing up → writing → restarting ask → waiting for health → done`),
   polling the `ask` container health and, when relevant, reranker `/health`.

**Error handling & rollback.** A failed write aborts before any restart. A
container that is unhealthy after a timeout surfaces a `docker logs` tail and
offers **one-click rollback** (restore the backup `.env` and restart again).
The local and cross-host steps report **independent** status, so a reranker
SSH failure never hides a successful Ask change — both outcomes are shown.

**Concurrency.** Apply is auth-gated and lock-guarded (a lockfile) so two open
tabs cannot race the `.env`.

## Connection testing

On-demand, separate from apply, run **server-side** (no browser CORS), against
the **pending unsaved values** so a host/model can be validated before it is
committed:

- **Ollama hosts** (chat host, serenity) → `GET /api/tags`, listing the models
  actually present. Catches the classic "you typed `granite4.1:8b` but it is
  not pulled on serenity." The returned list also **populates a picker** for
  the model fields.
- **Reranker** → `GET /health` with the bearer token.
- **Provider keys** → a light list-endpoint ping.

## UI layout

- **Left nav:** the seven categories (Models first / default).
- **Category body:** grouped cards. Models has **Chat**, **Serenity
  (classifier/expander/extractor)**, **Embeddings**, **Reranker**.
- **Fields** render by `type`: url/text inputs; secrets masked with a reveal
  toggle; bool switches; int steppers; enum selects (e.g. `EMBEDDING_MODEL`'s
  allowlist); the drag/add/remove **model-list editor**. Inline validation
  from the registry; a **Test** button where `testable`; model fields can pull
  a **picker from the live `/api/tags`** list.
- **Global bar:** dirty-state indicator → **Review changes** (masked diff) →
  **Save & Apply** with live status, plus a **Backups** list with one-click
  restore.

## Security

- **Auth:** a single shared-password gate (`MODEL_MANAGER_PASSWORD`),
  **fail-closed** — if the secret is unset the app refuses to serve rather than
  opening up — with a constant-time compare and a signed httpOnly session
  cookie. This mirrors the cron-auth hardening pattern already used in Ask.
- **Network:** LAN-bound; never publicly exposed.
- **Secrets:** masked in the UI, and never written to logs or diffs in
  plaintext. A field only writes a secret when it has actually been edited
  (unchanged secrets render as a masked placeholder and are left untouched).
- **Privilege note (documented in the app's README):** this container is
  powerful — read-write `.env`, the Docker socket, and an SSH key together are
  effectively root on the host. It must run only on the trusted host, LAN-only,
  behind the password gate.

## Testing strategy

- **Unit:** the `.env` parser (round-trips preserving comments/order/unknown
  keys; quoting; edit-in-place), registry validators, the masked-diff
  generator, and model-list serialization (add/remove/reorder).
- **Orchestration:** apply logic with docker and ssh **mocked** — the correct
  containers restart for a given changeset; the rollback path; independent
  local/remote status.
- **Auth:** fail-closed when the secret is unset, constant-time compare,
  cookie signing.
- **Connection tests:** ollama `/api/tags` parsing and reranker `/health`
  clients mocked.
- **Gates:** the same bar as Ask — typecheck, lint, format, build, vitest.

## Out of scope / follow-up

- **Remove Ask's Models settings tab.** Once the tool is live, delete the
  read-only `ModelsTab` from `components/settings-dialog.tsx` — the payoff of
  this project. This is a small, separate change to Ask, done after the tool
  is verified.
- **`ollama pull` from the UI** (pulling a not-yet-present model onto a host)
  is a plausible later affordance but is not built now; the tool validates
  presence and warns, it does not fetch models.
- No changes to Ask's runtime behavior beyond the three env fallbacks; the
  chat-model _selection_ mechanism (the `selectedModel` cookie / search-bar
  selector) is unchanged.

## Open items to settle at plan time

- Exact remote mechanism details for nightfuryS (SSH user, key location, the
  reranker repo path on that host).
- Whether the model-manager container joins the existing compose stack or runs
  as its own compose project.
- The port number and any reverse-proxy/hostname for LAN access.
- Backup retention count `N`.
