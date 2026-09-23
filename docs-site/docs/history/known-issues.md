---
title: Known issues
---

# Known issues and gotchas

Open problems, pending operator actions and traps a maintainer needs to know about, as of
**2026-09-22**. Each entry gives the **symptom**, its **impact**, a **workaround** and a **fix
sketch**. Resolved history lives in the [changelog](/history/changelog). Rationale for deliberate
trade-offs lives in [decisions](/history/decisions).

::: tip Severity legend
**High**: can lose data, money or availability. **Med**: a visible defect or a real but LAN-local
risk. **Low**: cosmetic, defence in depth, or a trap that only bites someone who does the wrong
thing.
:::

## Summary

| Issue | Area | Severity | Owner action |
|---|---|---|---|
| [Pre-existing test failures](#pre-existing-test-failures) | tests | Low | code |
| [Shared secrets across environments](#shared-secrets-across-environments) | security | Med | ops |
| [Secrets to rotate](#secrets-to-rotate) | security | Med | ops |
| [Unauthenticated LAN services](#unauthenticated-lan-services) | security | Med | ops |
| [Ingest and advanced-search share one token](#ingest-and-advanced-search-share-one-token) | security | Med | code + ops |
| [Signed upload URLs not enabled](#signed-upload-urls-not-enabled) | security | Low–Med | ops |
| [Redirect-based SSRF](#redirect-based-ssrf) | security | Low | accepted |
| [Other open audit items](#other-open-audit-items) | security | Low | decision |
| [Stopped label not rendered](#stopped-label-not-rendered) | UI | Low | code |
| [Chain-of-thought flash in the live stream](#chain-of-thought-flash-in-the-live-stream) | UI | Low | accepted |
| [Old answers with leaked reasoning stay leaked](#old-answers-with-leaked-reasoning-stay-leaked) | data | Low | manual |
| [Serenity (.171) Ollama intermittently unreachable](#serenity-171-ollama-intermittently-unreachable) | fleet | Low–Med | ops |
| [Stale mxbai embedding hints in code](#stale-mxbai-embedding-hints-in-code) | code | ~~Med~~ fixed 2026-09-22 (Model Manager dropdown still open) | code |
| [Other stale comments and docs](#other-stale-comments-and-docs) | code | Low | code |
| [Crop experiment data unread](#crop-experiment-data-unread) | search | Low | analysis |
| [Delisted model picks keep being used](#delisted-model-picks-keep-being-used) | models | Low | by design |
| [Overlay-pinned env vars beat `.env`](#overlay-pinned-env-vars-beat-env) | config | Med (trap) | awareness |
| [Boot and power-loss fragilities](#boot-and-power-loss-fragilities) | fleet | Med | awareness |
| [crawl4ai memory guard is blind](#crawl4ai-memory-guard-is-blind) | fleet | Med | watchdog |
| [Ingest wait and ingestor single point of failure](#ingest-wait-and-ingestor-single-point-of-failure) | uploads | Med | awareness |
| [Mobile keyboard / composer on real devices](#mobile-keyboard-composer-on-real-devices) | UI | Low | verify |
| [Lab archive tag missing](#lab-archive-tag-missing) | git | Low | info |
| [Serenity Ollama bound to loopback](#serenity-ollama-bound-to-loopback) | fleet | **High (live)** | ops |
| [Retired .231 Ask stacks running again](#retired-231-ask-stacks-running-again) | fleet | ~~Med~~ fixed 2026-09-23 | done (volumes kept) |
| [Unresolvable service hostnames](#unresolvable-service-hostnames) | config | ~~Med~~ fixed 2026-09-23 (all envs) | done |
| [SearXNG failure empties a quality search](#searxng-failure-empties-a-quality-search) | search | Med | code |
| [Legacy crawler has no SSRF guard](#legacy-crawler-has-no-ssrf-guard) | security | Low | code |
| [Answer deadline does not block tools](#answer-deadline-does-not-block-tools) | chat | Low | code |
| [Recall is dropped on most turns](#recall-is-dropped-on-most-turns) | memory | Med | code/tuning |
| [Unresolved citations](#unresolved-citations) | chat | Low–Med | analysis |
| [Memory consolidation never runs](#memory-consolidation-never-runs) | memory | Med | code + ops |
| [Home-started chats keep a stale last-viewed time](#home-started-chats-keep-a-stale-last-viewed-time) | sidebar | Low | code |
| [Possible duplicate ingestion](#possible-duplicate-ingestion) | uploads | Low | code |
| [Fleet automation drift](#fleet-automation-drift) | fleet | Low (mostly fixed 2026-09-23; host Node version open) | ops |

---

## Found while writing this documentation (2026-09-22)

These were discovered by checking every page's claims against the live system and code. They are
not yet fixed unless stated.

### Serenity Ollama bound to loopback

- **Symptom.** The app logs `ECONNREFUSED 192.168.50.171:11434` (title generation, `[warm]` lines).
- **Cause.** Serenity's native Ollama listens on `127.0.0.1:11434` only; its systemd drop-in has no
  `OLLAMA_HOST`. Possibly reset by the weekly Ollama auto-update (unverified).
- **Impact (live).** Everything on `LOCAL_LLM_BASE_URL` fails: chat titles, long-term memory
  extraction, the query-expander fallback.
- **Fix sketch.** Add `Environment="OLLAMA_HOST=0.0.0.0:11434"` (or the LAN IP) in
  `/etc/systemd/system/ollama.service.d/override.conf` on .171, `systemctl daemon-reload && systemctl restart ollama`,
  re-pin granite. **Trade-off:** this re-exposes an unauthenticated Ollama on the LAN — see
  [unauthenticated LAN services](#unauthenticated-lan-services); prefer a LAN firewall rule allowing only .17.
  Also re-enable `ask-fleet-boot` on .171 (it is disabled there).

### Retired .231 Ask stacks running again

- The prod/staging/lab Ask stacks on MiniNightFury (.231) were retired on 2026-08-27/28 but are
  **running again** (recreated at .231's 2026-09-16 boot by an outdated `~/ask-fleet-boot.sh`;
  `fleet-boot/deploy.sh` never syncs .231). .231 also still runs `ask-expire-uploads.sh` and
  Mullvad-rotation crons for them. They receive no traffic.
- **Fix sketch.** Stop and remove them (keep: crawl4ai, public SearXNG `:8127`, degoog `:4444`,
  cloudflared), update .231's boot script, prune its crontab, add .231 to `deploy.sh`.
  See [runbooks](/operations/runbooks).
- **Status: fixed 2026-09-23.** All 16 containers of `ask-stack`, `ask-stack-admin-feature` and
  `ask-stack-lab` on .231 (app, Postgres, Redis, SearXNG, gluetun, `ask-tts-lab`) were stopped and
  removed, along with their three `_default` networks. **Their volumes were kept** for an owner
  decision (`ask-postgres-data`, `-admin-feature`, `-lab` at ~49 MB each; the redis, uploads,
  model-cache and searxng volumes are empty or a few bytes). .231's `~/ask-fleet-boot.sh` now
  matches the repo (it reconciles only `crawl4ai` and `flaresolverr`), `fleet-boot/deploy.sh`
  includes .231, and the .231 crontab no longer runs `ask-expire-uploads.sh`. Its rotation cron
  now runs `~/fleet-boot/rotate-daily.sh public-searxng degoog`.

### Unresolvable service hostnames

On NightFuryX (.17) these container names do not resolve, so each silently degrades:

| Setting | Where | Effect |
|---|---|---|
| `CRAWL4AI_URL=http://crawl4ai:11235` | hardcoded in `docker-compose.admin-feature.yaml` (overrides `.env`) | **Staging** never reaches crawl4ai; falls back to the capped in-process crawler |
| `FLARESOLVERR_URL=http://flaresolverr:8191` | all envs | FlareSolverr fetch-rescue tier is dead everywhere (the .231 instance listens on loopback only) |
| `SEARXNG_FALLBACK_API_URL=http://searxng:8080` | prod/staging | No SearXNG fallback if a gluetun sidecar dies |

- **Fix sketch.** Point them at LAN IPs (or remove the dead tiers); remove the staging overlay pin.
  Related: staging/lab overlays point the classifier at `.231:11434` while prod uses `.17`.
- **Status: fixed 2026-09-23 (prod, staging, lab).** The staging overlay pin is gone, so staging
  inherits `.env`'s `CRAWL4AI_URL=http://192.168.50.231:11235`. FlareSolverr on .231 now also
  publishes on `192.168.50.231:8191`, and every env sets `FLARESOLVERR_URL=http://192.168.50.231:8191`.
  Prod and staging set `SEARXNG_FALLBACK_API_URL=http://192.168.50.231:8127` (the public SearXNG);
  lab keeps its fallback disabled. The staging and lab classifiers use `.17:11434`, like prod.
  Checked from inside each app container: all four targets return 200.

### SearXNG failure empties a quality search

- When SearXNG and its fallback both reject, `advancedSearchXNGSearch` catches the error and returns
  **empty results — discarding the Tavily/Brave/LangSearch/Ollama results already gathered**.
- **Fix sketch.** Treat SearXNG as one provider among several: on failure, continue with the others.

### Legacy crawler has no SSRF guard

- `crawlPage`/`fetchHtml` in `app/api/advanced-search/route.ts` use raw `http.get`, follow
  redirects recursively, and never call `assertUrlAllowed`. Not directly exploitable today (the
  route is token-gated and its URLs come from search engines, not users) but inconsistent with
  the `fetch` tool's guard.
- **Fix sketch.** Route it through the same SSRF guard (and re-check each redirect hop).

### Answer deadline does not block tools

- `applyAnswerDeadline` (200 s) returns `activeTools: []`, which only stops *advertising* tools —
  the AI SDK still executes calls against the full `tools` map (see
  [decisions](/history/decisions)). A late `fetch` can still run; its note to the model
  ("another tool call is impossible") is inaccurate.
- **Fix sketch.** Enforce in the tool `execute` (as the search round cap does) or withhold tools.

### Recall is dropped on most turns

- Prod telemetry (46 recent turns): `recall_budget_hit=true` on 31; true `recall_ms` ≈ 5.5 s vs the
  1.5 s `RECALL_BUDGET_MS` cap. Past-conversation context rarely reaches the answer.
- **Fix sketch.** Make recall itself faster (smaller rerank pool, cache) or accept and document it;
  measure answer quality before raising the budget (it sits on time-to-first-token).

### Unresolved citations

- 10 of 46 recent prod turns had `citations_unresolved > 0` (anchors the model invented), across
  several models. The UI drops them (per-message citation maps), so nothing wrong is shown — but
  the claim they supported is uncited. Worth tracking per model.

### Memory consolidation never runs

- No cron calls `/api/memory/consolidate` on .17 or .231, and `consolidateAllActiveUsers`
  (`lib/agents/memory-consolidator.ts:39`) lists users with the RLS-restricted `db`, which returns 0
  rows under `app_user` (`recall-backfill` correctly uses `dbAdmin`). Unverified at runtime.
- **Fix sketch.** Use `dbAdmin` for the user listing; schedule the route (cron with the secret).

### Home-started chats keep a stale last-viewed time

- A chat started from the home page never gets a `providedId` client-side, so follow-up sends never
  call `touchChat`. The sidebar reorders live, but after a reload the chat can sort lower than it
  should. See [client state](/request-lifecycle/client-state).
- **Fix sketch.** Call `touchChat` for home-started chats too (after the row exists).

### Possible duplicate ingestion

- The ingestor claims any `pending` file, so it can re-process a file the in-app fast path is still
  indexing and overwrite its chunks. Not observed in production. Fix: mark fast-path files
  `processing` before indexing.

### Fleet automation drift

- `ask-fleet-boot` disabled on .171; `rotate-mullvad.sh` runs prod `pin`/`city` from the staging
  worktree; `rebuild-ask.sh` exits 0 even when the app never returns 200 (read its `final` line);
  reranker and Whisper rely on "device 0 is the 2080 Ti" (no `CUDA_VISIBLE_DEVICES`); the ingestor
  directory is not in git and boot recovery reconciles only the prod ingestor; host Node is 20
  while `engines` requires 22; `UPLOAD_TTL_DAYS` has two different code defaults (0 and 14); the
  Model Manager offers an `EMBEDDING_MODEL` dropdown that would corrupt recall if changed.
- **Status (2026-09-23).** Fixed: `ask-fleet-boot` is enabled on .171; `rotate-mullvad.sh`
  `pin`/`city` run from each env's own worktree; `rebuild-ask.sh` exits 1 and skips the reclaim
  when the app never returns 200; the reranker and Whisper are pinned to the 2080 Ti by UUID with
  `CUDA_VISIBLE_DEVICES`; `/home/nightfury/selfhosted/ingestor` is a git repo (env files not
  tracked); and boot recovery reconciles all three ingestors. Still open: host Node 20 while
  `engines` requires 22.

## Tests

### Pre-existing test failures

- **Symptom.** `bun run test` exits non-zero. On 2026-09-22 (lab `flow-design`): **7 files / 26
  tests fail**, 1,785 pass, 1 skipped. The same files and counts fail on a clean `dev` HEAD, so
  these are not regressions from recent work. `next build` does not gate on tests.
- **Failing files and likely cause** (cause inferred from the assertion text; not individually
  debugged):

  | File | Tests | Likely cause |
  |---|---|---|
  | `lib/tools/search/providers/__tests__/searxng.test.ts` | 12 | Stale against the degoog-disabled and "images only at advanced depth" changes; most time out at 5 s |
  | `components/__tests__/source-selector.test.tsx` | 7 | UI changed: no button matching `/web\|academic\|social/i` any more (jsdom popover) |
  | `components/__tests__/chat-panel.test.tsx` | 3 | Ingest-polling tests with fake timers; jsdom lacks `HTMLCanvasElement.getContext` (the three-body canvas) |
  | `lib/agents/__tests__/title-generator.test.ts` | 1 | Expects `granite4.1:8b`; the default is now `granite4.2:8b` |
  | `lib/utils/__tests__/model-selection.test.ts` | 1 | Asserts "thinking ON" as the default; reasoning is now OFF by default ([D10](/history/decisions#d10-answering-model-reasoning-off-by-default)) |
  | `lib/search/__tests__/brave-budget.test.ts` | 1 | "fails CLOSED when Redis is missing" hits a real Redis connection timeout; environment-dependent |
  | `app/api/voice/__tests__/speak.test.ts` | 1 | Expects 400 on oversized text; gets 200 since read-aloud speaks the full answer |

- **Impact.** Noise. CI on `dev` is red, which hides new failures.
- **Workaround.** Compare the failing list against this table. Anything new is yours.
- **Fix sketch.** Update the stale expectations (title model, think default, voice text cap); mock
  Redis in the Brave-budget test; add a canvas stub to the Vitest jsdom setup; rewrite the
  source-selector and SearXNG tests against current behaviour. The count was 12 tests on
  2026-08-22 and has grown since. See [testing](/operations/testing-qa).

---

## Security (awaiting ops action)

All of these come from the 2026-08-09 and 2026-09-14 audits. The public surface was judged
**strong** (no critical or high finding). What remains is LAN-local or operational. A turnkey
runbook exists outside the repo at `/home/nightfury/selfhosted/security-runbook.md` (no secret
values in it). Details: [security](/infrastructure/security).

### Shared secrets across environments

- **Symptom.** `INGEST_API_TOKEN`, `MEMORY_CRON_SECRET` and `MODEL_MANAGER_SESSION_SECRET` are
  byte-identical in prod, staging and lab.
- **Impact (Med).** Lab runs `ENABLE_AUTH=false`, so a lab compromise hands over prod's secrets.
  With `MEMORY_CRON_SECRET` an attacker can POST `/api/memory/{consolidate,recall-backfill}`
  (reachable through the tunnel) and rewrite or re-embed every user's memory. With
  `INGEST_API_TOKEN` they can download any user's file via `ingest/file/[id]` (which bypasses RLS)
  and inject chunks into a victim's `.chunks.json`, a stored prompt injection. The gates themselves
  are sound (timing-safe, fail closed with 503).
- **Workaround.** None. Keep lab LAN-only.
- **Fix sketch.** Generate distinct per-env values. The app and its ingestor must share **the same**
  `INGEST_API_TOKEN` per env: each ingestor reads its own `ingestor/.env`, `.env.staging` or
  `.env.lab`. Set `MODEL_MANAGER_SESSION_SECRET` explicitly; it currently derives from the password
  when unset. Recreate the containers afterwards.

### Secrets to rotate

- **Symptom.** Several secrets were exposed in plain text in tool transcripts during maintenance:
  `DEGOOG_API_KEY` (2026-09-07), and the whole lab `.env` (2026-09-11). The lab file contained
  the Supabase secret key, the Tavily, Firecrawl, Brave, Replicate and LangSearch API keys, the
  crawl4ai, reranker, embedding, ingest and memory-cron tokens, and the SearXNG secret.
- **Impact (Med).** It depends on where those transcripts are retained.
- **Fix sketch.** Rotate them in each provider's dashboard, then update every env's `.env` (via
  [Model Manager](/history/decisions#d26-model-manager-is-the-sanctioned-env-editor) for prod) and
  recreate. Because of the shared-secret issue above, rotate per env, not globally.
- The three world-readable `.env` files (lab, ingestor, reranker at mode 0664) were fixed with
  `chmod 600` on 2026-09-15. Keep new `.env` files at `600`.

### Unauthenticated LAN services

- **Symptom.** These services listen on `0.0.0.0` with no auth:
  - Ollama `:11434` on each GPU host
  - Whisper STT `:8788` on `.17`
  - Kokoro TTS `:8890` (and lab `:3744`)
  - the per-env SearXNG UIs (proxy ports `3741`, `3740`, `3743`)
- **Impact (Med, LAN only).** Any LAN host can `POST /api/generate` with a `…:cloud` model and
  **drain the paid Ollama Cloud balance**, or use the GPUs for free. Whisper's OpenAI-compatible API
  can pull arbitrary Hugging Face models (disk fill). SearXNG is an open search proxy that burns the
  Mullvad exit IP's reputation.
- **Workaround.** Keep the LAN trusted.
- **Fix sketch.** A LAN firewall or ACL, or a token-checking reverse proxy. Binding to `127.0.0.1`
  is not possible because the app calls these services across hosts. Copy the reranker's pattern
  (`:8787`, token-gated with `hmac.compare_digest`, fails closed).

### Ingest and advanced-search share one token

- **Symptom.** `/api/advanced-search` authenticates with `checkIngestAuth`
  (`app/api/advanced-search/route.ts:542`), i.e. the same `INGEST_API_TOKEN` as the ingest worker
  endpoints.
- **Impact.** Anyone who can call search can also call the RLS-bypassing ingest file endpoints, and
  the reverse.
- **Fix sketch.** A small code change: a separate `ADVANCED_SEARCH_API_TOKEN` read by a sibling
  of `lib/utils/ingest-auth.ts`, passed by `lib/tools/search.ts`. Ship it together with the per-env
  secret split. It was flagged as awaiting the owner's go-ahead.

### Signed upload URLs not enabled

- **Symptom.** `/uploads/[...path]` still serves any file to anyone holding the (unguessable) path.
  Signed URLs shipped **dormant** on 2026-09-12 ([D25](/history/decisions#d25-signed-upload-urls-shipped-dormant)).
- **Impact.** Upload links are permanent and cannot be revoked. In anonymous mode the userId path
  segment is a known constant.
- **Fix sketch (order matters).**
  1. Set `UPLOADS_URL_SECRET` (≥ 32 characters) on **lab** first.
  2. Set `UPLOADS_REQUIRE_SIGNATURE=true`.
  3. Test: old chats' images and citations still render; a fresh upload works; a tampered URL gives
     403 and an expired one gives 410.
  4. Repeat per env.

  ::: danger
  Setting `UPLOADS_REQUIRE_SIGNATURE=true` **without** the secret **fails open**: unsigned files are
  still served. The guard is `requireSignature && signingConfigured`.
  :::
  These knobs may not be in Model Manager's env schema yet *(unverified)*.

### Redirect-based SSRF

- **Symptom.** `lib/tools/fetch.ts` runs `assertUrlAllowed` once, then fetches with
  `redirect: 'follow'`. A public URL that 302s to `http://192.168.50.x` reaches the LAN fleet.
  DNS-rebinding TOCTOU also applies (`ssrf-guard.ts`).
- **Impact (Low on this LAN).** There is no metadata service and no secret-bearing unauthenticated
  internal HTTP. Response bodies do flow back to the model.
- **Status.** Left as is by the owner's choice on fetch egress. Fix if wanted: `redirect: 'manual'`
  and re-check each hop.

### Other open audit items

These are decisions still pending, not bugs:

- **H2.** `SEARXNG_FALLBACK_API_URL` resolves to the **public** SearXNG on every env, because of a
  shared-infra DNS alias collision. Decide whether prod may fail over there.
- **H5.** No local fallback when a cloud model returns 402. A mid-stream retry needs design work.
- **M3.** Metered search budgets can be double-spent across envs that share API keys.
- **M8.** The `OLLAMA_MODELS` list is not health-gated (it is operator-curated).
- **Supabase dashboard.** Tighten the redirect allowlist (the companion to the `safeRelativePath`
  fix).
- **mathjs DoS.** The `calculate` tool is bounded by a 512-character cap and a power-tower reject,
  but there is no hard synchronous timeout. That would need a worker thread.
- **Dead code.** The `referer.includes('/share/')` guard in `app/api/chat/route.ts:100` is dead;
  the public path is `/search/[id]`, and no `/share/` route exists.

---

## Chat and UI

### Stopped label not rendered

- **Symptom.** After Stop, the partial answer is kept and `metadata.stopped=true` is persisted
  (`lib/streaming/helpers/sanitize-stopped-message.ts`). No component reads it, so a stopped answer
  looks like a complete one.
- **Impact.** Users can mistake a truncated answer for a full one.
- **Fix sketch.** In the answer's action row (`render-message.tsx` / `MessageActions`), render a
  muted "Stopped" badge when `message.metadata?.stopped` is true.

### Chain-of-thought flash in the live stream

- **Symptom.** On some models (seen on glm), a short burst of process narration or reasoning is
  visible while the answer streams. It disappears after reload.
- **Impact.** Cosmetic.
- **Why it isn't "fixed".** The live transform (`smooth-and-strip-narration.ts`) has to decide from
  a prefix and is deliberately conservative. An aggressive live stripper silently dropped real
  answers in July 2026. Persisted messages are cleaned by the persist-time strippers. See
  [D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live).
- **Fix sketch.** Add the new starter phrases to `NARRATION_STARTERS` with tests. Don't loosen the
  buffer ceiling without a corpus. If leaks become frequent, re-evaluate
  [targeted reasoning](/history/decisions#d18-targeted-reasoning-reasoning-only-on-research-turns).

### Old answers with leaked reasoning stay leaked

- **Symptom.** Answers saved before 2026-09-17 (`0290896c`) may contain a long reasoning preamble
  or a stray `</think>`.
- **Workaround.** Regenerate the answer. The strippers act at persist time only.
- **Fix sketch.** A one-off backfill that runs `stripNarrationFromMessage` over stored `parts`
  *(not built)*.

### Mobile keyboard / composer on real devices

- **Symptom.** Composer anchoring while typing on phones (`41f8ed8e`) and the click/keyboard timing
  of the mid-stream refresh fixes could only be checked headlessly, not on a real on-screen keyboard.
- **Workaround.** Verify on a device after any change to `chat-panel.tsx` or `chat.tsx`.
- **Fallback plan.** If the caret still drifts, pin the composer to the bottom (chat-app style).
  The empty-state autofocus on touch devices was also flagged as a possible contributor (it pops
  the keyboard on load).

---

## Fleet and operations

### Serenity (.171) Ollama intermittently unreachable

- **Symptom.** Lab logs on 2026-09-22 show
  `Error generating chat title with LLM … ECONNREFUSED 192.168.50.171:11434` and
  `[warm] … "failed":1, "errors":["192.168.50.171:11434:fetch failed"]`.
- **Impact.** `.171` is `LOCAL_LLM_BASE_URL`: it serves `granite4.2:8b` for title generation,
  memory extraction, the query-expander fallback and the voice gist. Titles fall back to the
  opening words of the question, and memory extraction for that turn is skipped. Answers are
  unaffected.
- **Workaround.** Check `curl http://192.168.50.171:11434/api/ps`. After any Ollama restart, no
  model is resident, because `keep_alive=-1` only pins after the first load. Re-pin with
  `/api/generate {"model":"granite4.2:8b","keep_alive":-1}`. SSH to `.171` works from `.17`
  (added 2026-08-28).
- **Fix sketch.** Find out whether it is the weekly Ollama auto-update (Sun 03:30), WSL sleep or GPU
  reset (unverified). Consider a periodic re-warm like the app's warm pings. Confirm the live
  `~/ask-fleet-boot.sh` on `.171` warms `granite4.2:8b`, not the deleted `4.1`. The repo copy was
  fixed in `325ab31f`; the live `.171` copy was still pending as of 2026-08-28. See
  [runbooks](/operations/runbooks).

### Overlay-pinned env vars beat `.env`

- **Trap.** An overlay's `environment:` block beats `.env`. Staging (`docker-compose.admin-feature.yaml`)
  and lab (`docker-compose.lab.yaml`) hard-code some values, for example `CLASSIFIER_MODEL_ID`.
  Prod hard-codes `DEGOOG_ENABLED` in the **tracked** base `docker-compose.yaml:61`.
- **Symptom.** You change `.env`, recreate, and staging or lab still shows the old value.
- **Workaround.** Always confirm with `docker exec <container> printenv VAR` (mask secrets; never
  grep `.env` for secret-bearing names on screen). A code default (`?? 'x'`) is not what is deployed.
- **Related.** Each env runs from **its own worktree's** compose files. The lab worktree's copy of
  another env's overlay can drift from what that env actually runs.

### Boot and power-loss fragilities

- **.17 runs Docker Desktop on WSL2**, not native Docker. Unattended recovery depends on Windows
  `AutoAdminLogon=1` and Docker Desktop `AutoStart=true`. If either is reset, a reboot needs a
  manual login.
- **gluetun cold-boot race.** After a hard power cut the VPN sidecars can exit 127 (`/dev/net/tun`
  race), which takes SearXNG down with them. `ensure_vpn_search()` in `ask-fleet-boot.sh` retries
  6× at 10 s intervals. Its failure path has not yet been exercised by a real hard cut since the
  fleet went on a UPS (2026-08-27).
- **Prod stranded on the wrong network after a reboot.** `ask` rejoins only `shared-infra` and
  crash-loops on `ENOTFOUND postgres`. The fix is `docker stop ask` then
  `docker compose -f docker-compose.yaml -f docker-compose.vpn.yaml up -d --force-recreate ask`
  from `ask-prod`. `reconcile_app_stack` in fleet-boot now does this automatically.
- **The ingestors** (`ingestor`, `ingestor-staging`, `ingestor-lab`) rely only on
  `restart: unless-stopped`; they are not in fleet-boot's reconcile.
- **Never run a bare `docker compose up -d` in `ask/`.** The base compose is `name: ask-stack` =
  **prod**, so it would recreate prod with staging's `.env` and no VPN overlay. Use
  `fleet-boot/rebuild-ask.sh {prod|staging|lab}` or the exact `-p`/`-f` sets. See
  [environments](/operations/environments).
- **Rebuilds in the background get killed** by the tool harness's memory budget (not a host OOM).
  Run `rebuild-ask.sh` in the foreground.

### crawl4ai memory guard is blind

- **Symptom.** Retrieval slows to minutes (`slowest_chunk_ms` ~125 s in `[latency:search]`), with
  `Crawl4AI HTTP 500`s.
- **Cause.** `psutil` inside the container sees the host's 31 GiB, not the 8 GiB cgroup limit. The
  `memory_threshold_percent: 95` guard can never fire, and the container creeps toward OOM.
- **Mitigation.** `crawl4ai/memory-watchdog.sh` on `.231` (cron `*/15`) restarts it above 80% of
  its own cgroup limit. That is a watchdog, not a fix.
- **Don't** raise crawl parallelism ([D21](/history/decisions#d21-other-latency-knobs-measured)).

### Ingest wait and ingestor single point of failure

- **Symptom.** For a turn with a worker-path attachment (image, office file or media), the answer
  path blocks until ingest finishes, up to `INGEST_WAIT_TIMEOUT_MS`. If no worker claims the job
  within `INGEST_WAIT_UNCLAIMED_MS` (8 s) and the Redis heartbeat `ingest:heartbeat` is stale, the
  user is told processing is down.
- **Impact.** A down ingestor means non-vision models cannot see images at all. The app makes no
  live VLM call; `qwen3-vl:4b` runs only at ingest time.
- **Discrepancy.** Older notes say `INGEST_WAIT_TIMEOUT_MS` defaults to 120000. Since `8795e1b9`
  (2026-09-10) the **code default is 30000 on every branch**. Check each env's `printenv` for an
  override.
- **Check.** `redis-cli TTL ingest:heartbeat` in the env's Redis (a positive TTL means alive).
- **Also.** The ingestor is **single-target** (one `ASK_URL`), so each env has its own worker. A
  new env needs its own ingestor project.

### Crop experiment data unread

- **Symptom.** Prod and staging have logged `[crop-pos]` and `[cite-urls]` since 2026-08-06
  ([D17](/history/decisions#d17-20k-per-page-crop-with-a-crop-position-shadow)). No analysis has
  been recorded.
- **Fix sketch.** Join by `chatId` and compute the `t=1` (tail-loss) fraction among **cited** URLs.
  If it is negligible, revert to 10k (`SEARCH_ENRICH_MAX_CHARS=10000`) for smaller prompts, and
  consider sample-rating or turning off the shadow (audit M4). Container logs reset on every
  rebuild, so collect them before redeploying.

### Delisted model picks keep being used

- **By design** ([D27](/history/decisions#d27-saved-model-pick-outranks-the-default)). Removing a
  model from `OLLAMA_MODELS` does not move users who saved it. Read `modelId` from `[latency]` to
  see what really ran.

---

## Code hygiene

### Stale mxbai embedding hints in code

- **Where.**
  - `lib/memory/write.ts:20-21`: a comment says `user_memories` is "pinned to mxbai".
  - `lib/memory/write.ts:81`: the dimension-mismatch **error message** tells operators to
    `Set EMBEDDING_MODEL=mixedbread-ai/mxbai-embed-large-v1`.
  - `lib/embeddings/rerank.ts:18`: an older comment mentions mxbai for indexing.
- **Why it matters (trap).** The live embedder is **Qwen3-Embedding-0.6B**. mxbai is also 1024-d,
  so following that advice passes the dimension guard and **silently corrupts** memory and recall
  ([D24](/history/decisions#d24-the-embedding-model-is-data-locked)).
- **Status: fixed 2026-09-22** — comments and the error message in `lib/memory/write.ts`, the hint in
  `components/settings/memory-tab.tsx`, and `lib/embeddings/rerank.ts` now name Qwen3 and warn against
  switching. Still open: the Model Manager's `EMBEDDING_MODEL` dropdown.
- **Original fix sketch.** Rewrite the comments and the error message to name Qwen3 and to warn against
  switching. The equivalent comment in `lib/memory/recall-index.ts` was already fixed in
  `8795e1b9`.

### Other stale comments and docs

- `CLAUDE.md` at the repo root is mostly the **upstream morphic** guide. It lists Vercel AI SDK 5
  alpha (the app runs v6), OpenAI/Tavily as required keys, `/share/` routes and
  `public/config/models.json`. Trust this site and the code instead.
- The SearXNG provider tests (`lib/tools/search/providers/__tests__/searxng.test.ts`) still expect
  degoog to be merged into every search. degoog is disabled in every env (`DEGOOG_ENABLED=false`).
- The `NEXT_PUBLIC_VOICE_ENABLED` and other `NEXT_PUBLIC_*` flags are build-inlined from each
  worktree's `.env`. Compose comments that present them as runtime env were corrected in
  `90f5e6a6`. Watch for new ones.

### Lab archive tag missing

- Notes from 2026-08-22 say the pre-merge lab tip was archived as tag `lab-archive-2026-08-22`
  before `dd7e0ca1`. **No tags exist** in the local repository as of 2026-09-22 (a remote tag listing also returned none). To
  recover the pre-merge lab state, use `dd7e0ca1^1` (the merge's first parent).
