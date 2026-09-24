---
title: Known issues
---

# Known issues and gotchas

Open problems, pending operator actions and traps a maintainer needs to know about, as of
**2026-09-24**. Each entry gives the **symptom**, its **impact**, a **workaround** and a **fix
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
| [Pre-existing test failures](#pre-existing-test-failures) | tests | ~~Low~~ fixed 2026-09-23 (all branches) | done |
| [Shared secrets across environments](#shared-secrets-across-environments) | security | Med | ops |
| [Secrets to rotate](#secrets-to-rotate) | security | Med | ops |
| [Unauthenticated LAN services](#unauthenticated-lan-services) | security | Med | ops |
| [Ingest and advanced-search share one token](#ingest-and-advanced-search-share-one-token) | security | Med | code + ops |
| [Signed upload URLs not enabled](#signed-upload-urls-not-enabled) | security | Low–Med | ops |
| [Redirect-based SSRF](#redirect-based-ssrf) | security | Low | accepted |
| [Other open audit items](#other-open-audit-items) | security | Low | decision (H2 decided 2026-09-23) |
| [Stopped label not rendered](#stopped-label-not-rendered) | UI | ~~Low~~ fixed 2026-09-24 | done |
| [Chain-of-thought flash in the live stream](#chain-of-thought-flash-in-the-live-stream) | UI | Low | accepted |
| [Old answers with leaked reasoning stay leaked](#old-answers-with-leaked-reasoning-stay-leaked) | data | Low | manual |
| [Serenity (.171) Ollama intermittently unreachable](#serenity-171-ollama-intermittently-unreachable) | fleet | Low (cause fixed 2026-09-23) | watch |
| [Stale mxbai embedding hints in code](#stale-mxbai-embedding-hints-in-code) | code | ~~Med~~ fixed 2026-09-22 (Model Manager field read-only since 2026-09-23) | done |
| [Other stale comments and docs](#other-stale-comments-and-docs) | code | Low (granite/compose/engines items fixed 2026-09-24) | code |
| [Crop experiment data unread](#crop-experiment-data-unread) | search | Low | analysis |
| [Delisted model picks keep being used](#delisted-model-picks-keep-being-used) | models | Low | by design |
| [Overlay-pinned env vars beat `.env`](#overlay-pinned-env-vars-beat-env) | config | Med (trap) | awareness |
| [Boot and power-loss fragilities](#boot-and-power-loss-fragilities) | fleet | Med | awareness |
| [crawl4ai memory guard is blind](#crawl4ai-memory-guard-is-blind) | fleet | Med | watchdog |
| [Ingest wait and ingestor single point of failure](#ingest-wait-and-ingestor-single-point-of-failure) | uploads | Med | awareness |
| [Mobile keyboard / composer on real devices](#mobile-keyboard-composer-on-real-devices) | UI | Low | verify |
| [Lab archive tag missing](#lab-archive-tag-missing) | git | ~~Low~~ tag present locally; .231 archive branches added 2026-09-23 | info |
| [Serenity Ollama bound to loopback](#serenity-ollama-bound-to-loopback) | fleet | ~~High~~ fixed 2026-09-23 | done (LAN exposure accepted) |
| [Retired .231 Ask stacks running again](#retired-231-ask-stacks-running-again) | fleet | ~~Med~~ fixed 2026-09-23; fully removed 2026-09-24 | done |
| [Unresolvable service hostnames](#unresolvable-service-hostnames) | config | ~~Med~~ fixed 2026-09-23 (all envs) | done |
| [SearXNG failure empties a quality search](#searxng-failure-empties-a-quality-search) | search | ~~Med~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Legacy crawler has no SSRF guard](#legacy-crawler-has-no-ssrf-guard) | security | ~~Low~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Answer deadline does not block tools](#answer-deadline-does-not-block-tools) | chat | ~~Low~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Recall is dropped on most turns](#recall-is-dropped-on-most-turns) | memory | ~~Med~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Unresolved citations](#unresolved-citations) | chat | ~~Low–Med~~ fixed 2026-09-24 (three pipeline causes) | watch `citations_unresolved` |
| [Memory consolidation never runs](#memory-consolidation-never-runs) | memory | ~~Med~~ fixed (code 2026-09-23, nightly cron 2026-09-24) | done |
| [Home-started chats keep a stale last-viewed time](#home-started-chats-keep-a-stale-last-viewed-time) | sidebar | ~~Low~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Possible duplicate ingestion](#possible-duplicate-ingestion) | uploads | ~~Low~~ fixed 2026-09-23 (lab, staging, prod) | done |
| [Fleet automation drift](#fleet-automation-drift) | fleet | ~~Low~~ fixed 2026-09-23; host Node item resolved 2026-09-24 | done |

---

## Found while writing this documentation (2026-09-22)

These were discovered by checking every page's claims against the live system and code. Most were
fixed on 2026-09-23 and shipped to lab, staging and prod the same day; each entry's **Status**
line says so. Prod (`dev`) commits are `fae9682a`..`50e03340` for the app fixes; the lab originals
are `06dfbd2b`..`80c44c6a` on `flow-design`.

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
- **Status: fixed 2026-09-23.** A new drop-in `/etc/systemd/system/ollama.service.d/host.conf` on
  .171 sets `Environment=OLLAMA_HOST=0.0.0.0:11434` (the existing `parallel.conf` is unchanged),
  and `granite4.2:8b` was re-pinned. `ss -ltn` on .171 shows `*:11434`. The owner **accepted the
  LAN exposure** (no firewall rule was added); it stays listed under
  [unauthenticated LAN services](#unauthenticated-lan-services). `ask-fleet-boot` is enabled on
  .171 again, and its synced `~/ask-fleet-boot.sh` warms `granite4.2:8b`. A drop-in survives the
  weekly `update-ollama.sh` reinstall, which rewrites only the main unit file.

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
- **Fully removed 2026-09-24.** The kept volumes, the three stacks' images and the old
  `ask`, `ask-prod` and `ask-flow` checkouts under `~/selfhosted` on .231 were deleted, so no
  Ask app code or data remains there (`docker volume ls`, `docker network ls` and
  `docker images` on .231 list nothing `ask`-named). A copy of their DB and upload volumes was
  already archived on .17 at `/home/nightfury/backups/ask-231-retire-2026-08-28/` when they were
  first retired. The 42 commits that existed only in .231's lab checkout were saved as local
  branches on .17 (see [lab archive tag](#lab-archive-tag-missing)). .231's weekly
  `fleet-update-public-search.timer` now runs `~/fleet-boot/update-public-search.sh` (and the
  crawl4ai version check) from the `~/fleet-boot` copy that `fleet-boot/deploy.sh` syncs.

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
- **Status: fixed and shipped 2026-09-23** (lab `06dfbd2b`, prod `fae9682a`). A SearXNG rejection or malformed
  body now becomes an empty SearXNG share (`resolveSearxngContribution`,
  `app/api/advanced-search/searxng-contribution.ts`), logged as `[searxng] advanced search failed,
  continuing with the other providers`; `[latency:search]` carries `searxng=failed`. The degraded
  result is returned but not cached. Tests: `app/api/advanced-search/__tests__/searxng-failure.test.ts`.


### Legacy crawler has no SSRF guard

- `crawlPage`/`fetchHtml` in `app/api/advanced-search/route.ts` use raw `http.get`, follow
  redirects recursively, and never call `assertUrlAllowed`. Not directly exploitable today (the
  route is token-gated and its URLs come from search engines, not users) but inconsistent with
  the `fetch` tool's guard.
- **Fix sketch.** Route it through the same SSRF guard (and re-check each redirect hop).
- **Status: fixed and shipped 2026-09-23** (lab `f5321457`, prod `4db7325e`). `fetchHtml` moved to
  `lib/utils/legacy-fetch-html.ts`; it runs `assertUrlAllowed` on the start URL and on every
  redirect target before following it, and caps chains at 5. Residual: DNS-rebinding TOCTOU (as for
  the `fetch` tool). Tests: `lib/utils/__tests__/legacy-fetch-html.test.ts`.


### Answer deadline does not block tools

- `applyAnswerDeadline` (200 s) returns `activeTools: []`, which only stops *advertising* tools —
  the AI SDK still executes calls against the full `tools` map (see
  [decisions](/history/decisions)). A late `fetch` can still run; its note to the model
  ("another tool call is impossible") is inaccurate.
- **Fix sketch.** Enforce in the tool `execute` (as the search round cap does) or withhold tools.
- **Status: fixed and shipped 2026-09-23** (lab `72fa6512`, prod `a3100ba6`). `enforceAnswerDeadline`
  (`lib/agents/answer-deadline.ts`) wraps every researcher tool's `execute`; past the deadline a call
  returns a non-error "answer now" result shaped like the tool's normal output and logs
  `[deadline] refused <tool> call`. The note now says further calls are refused. Tests drive the real
  SDK with a mock model calling `fetch` under `activeTools: []`
  (`lib/agents/__tests__/answer-deadline.test.ts`). The deadline clock now starts when the
  researcher is built for the turn (`turnStartedAt`, `lib/agents/researcher.ts:781`), not at the
  first step.


### Recall is dropped on most turns

- Prod telemetry (46 recent turns): `recall_budget_hit=true` on 31; true `recall_ms` ≈ 5.5 s vs the
  1.5 s `RECALL_BUDGET_MS` cap. Past-conversation context rarely reaches the answer.
- **Status: fixed and shipped 2026-09-23** (lab `f87b6d3d`, prod `d0585bf8`). Two causes: the 8B reranker's
  cost for 20 × 512-token passages (about 3.4 s alone), and the discarded speculative rerank
  holding the GPU ahead of the refetch rerank (3.3 s → 5.0 s). Speculation now prefetches only the
  embed and DB arms, and rerank runs once after `chooseRecall`. The default is 10 passages × 384
  tokens (about 1.3 s, near-identical injected hits on 40 real queries). Lab after: recall p50
  about 1.3 s, 0 of 5 budget hits. See
  [memory & recall → recall latency](/knowledge/memory-recall#recall-latency).
  No index or migration was needed. The new knob `RECALL_RERANK_MAX_LENGTH` (default 384) is
  editable in Model Manager. Decision record:
  [D34](/history/decisions#d34-recall-rerank-deferred-not-aborted).
- **Follow-up:** watch `recall_budget_hit` on prod `[latency]` lines; the margin is thin (see the
  warning in [recall latency](/knowledge/memory-recall#recall-latency)).

### Unresolved citations

- 10 of 46 recent prod turns had `citations_unresolved > 0` (anchors the model invented), across
  several models. The UI drops them (per-message citation maps), so nothing wrong is shown — but
  the claim they supported is uncited. Worth tracking per model.
- **Cause (found 2026-09-24).** Most unresolved anchors were not random inventions but three
  pipeline defects that gave the model no valid id to copy:
  1. **Fetch results carried no `toolCallId`.** Search results echo their id; fetch results did
     not, and the Ollama wire format carries no tool-call id on a tool result. A fetched page was
     structurally uncitable: 0 of 3,950 anchors in prod history named a fetch call, and messages
     with a fetch had about twice the unresolved rate (19.8 % vs 10.9 %).
  2. **History carried dead anchors.** Earlier answers kept their `[N](#<old id>)` anchors in the
     model-bound history, while `pruneMessages` had removed those turns' tool calls. Models copied
     the old ids. This was the largest class: 146 of 655 unresolved anchors across all history,
     and every anchor in follow-up turns that ran no search.
  3. **URL-shaped ids.** Without a visible id, models often wrote a piece of the page's own URL
     as the "id" (`[1](#example.com/some-page)`, a YouTube video id): 83 of 655.
- **Status: fixed 2026-09-24.**
  1. `lib/tools/fetch.ts:667,715` echoes the call's `toolCallId` in a successful fetch result
     (a failed fetch has nothing to cite and gets none).
  2. `stripCitationAnchorsFromHistory` (`lib/streaming/helpers/strip-citation-anchors-from-history.ts`)
     removes anchors from **prior** assistant turns before they reach the model. It runs in
     `create-chat-stream-response.ts:360` and `create-ephemeral-chat-stream-response.ts:122`. The
     stored and displayed text keeps its anchors.
  3. `resolveByUrlFragment` (`lib/utils/citation.ts:66`) resolves an anchor whose id is a
     fragment of **exactly one** of this message's source URLs. UUID-shaped ids, fragments shorter
     than 6 characters and fragments matching several URLs stay unresolved. Such anchors are
     counted as `citations_recovered` on the `[latency]` line, not as unresolved.
- **Measured** (replaying prod history through the new resolver): unresolved anchors fell from
  16.6 % to 14.5 % over all history, and from 7.1 % to 5.2 % over the last 45 days. That is the
  resolver alone. Fixes 1 and 2 are preventive and show up only on live turns. Ids that are
  genuinely invented are still dropped, by design. Other citation formats (bare `[3]`,
  `[source](url)`) never occur in prod history, so no parser was added for them. Anchors are
  **not** resolved across turns; see
  [D36](/history/decisions#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only).
- **Watch.** `citations_unresolved` (and `citations_recovered`) on prod `[latency]` lines after the
  port. A rate that stays near the old level on live turns means a cause is still missing.
  Tests: `lib/utils/__tests__/citation.test.ts`,
  `lib/streaming/helpers/__tests__/strip-citation-anchors-from-history.test.ts`,
  `lib/tools/__tests__/fetch-tool-call-id.test.ts`.

### Memory consolidation never runs

- No cron calls `/api/memory/consolidate` on .17 or .231, and `consolidateAllActiveUsers`
  (`lib/agents/memory-consolidator.ts:39`) lists users with the RLS-restricted `db`, which returns 0
  rows under `app_user` (`recall-backfill` correctly uses `dbAdmin`). Unverified at runtime.
- **Fix sketch.** Use `dbAdmin` for the user listing; schedule the route (cron with the secret).
- **Status: code fix shipped 2026-09-23 (lab `f80ff6d7`, prod `995f23f3`); scheduled 2026-09-24.**
  The user listing now uses `dbAdmin`; per-user work stays RLS-scoped.
  Tests: `lib/agents/__tests__/memory-consolidator.test.ts`. A nightly job,
  `fleet-boot/memory-consolidate-nightly.sh`, runs from the .17 crontab at 03:45. It reads each
  env's `MEMORY_CRON_SECRET` from that env's own `.env` and passes it to `curl` on stdin, so the
  value never appears in argv or logs. Once the script is on `dev` the crontab line is
  `45 3 * * * /home/nightfury/selfhosted/ask-prod/fleet-boot/memory-consolidate-nightly.sh prod staging lab`.
  Details: [memory & recall → how to schedule](/knowledge/memory-recall#how-to-schedule-memory-consolidation)
  and [fleet scripts](/operations/fleet-scripts#memory-consolidate-nightly-sh).


### Home-started chats keep a stale last-viewed time

- A chat started from the home page never gets a `providedId` client-side, so follow-up sends never
  call `touchChat`. The sidebar reorders live, but after a reload the chat can sort lower than it
  should. See [client state](/request-lifecycle/client-state).
- **Fix sketch.** Call `touchChat` for home-started chats too (after the row exists).
- **Status: fixed and shipped 2026-09-23** (lab `b51a4a0d`, prod `5070af4c`). `safeSendMessage` bumps and
  `touchChat`s a home-started chat's follow-ups (it has messages before the send), still with no
  refresh event. See [client state](/request-lifecycle/client-state#known-gaps).


### Possible duplicate ingestion

- The ingestor claims any `pending` file, so it can re-process a file the in-app fast path is still
  indexing and overwrite its chunks. Not observed in production. Fix: mark fast-path files
  `processing` before indexing.
- **Status: fixed and shipped 2026-09-23** (lab `72edc7d8`, prod `6a6c68af`). Fast-path rows are created
  `processing` with `ingest_stage='fast-path'` and a fresh `claimed_at`, which the claim query skips
  until stale (30 min). Success → `ready`; declined or failed → `releaseFastPathToWorker` puts it
  back to `pending` for the worker. See [RAG uploads](/knowledge/rag-uploads#fast-path-in-app).


### Fleet automation drift

- **Found 2026-09-22.** `ask-fleet-boot` disabled on .171; `rotate-mullvad.sh` ran prod
  `pin`/`city` from the staging worktree; `rebuild-ask.sh` exited 0 even when the app never
  returned 200; the reranker and Whisper relied on "device 0 is the 2080 Ti" (no
  `CUDA_VISIBLE_DEVICES`); the ingestor directory was not in git and boot recovery reconciled only
  the prod ingestor; `UPLOAD_TTL_DAYS` had two different code defaults (0 and 14); the Model
  Manager offered an `EMBEDDING_MODEL` dropdown that would corrupt recall if changed; .231 was not
  in `fleet-boot/deploy.sh`; host Node is 20 while `engines` requires 22.
- **Status: fixed 2026-09-23 (all shipped); the host Node item was resolved 2026-09-24.**
  - `ask-fleet-boot` is enabled on all four hosts, and `deploy.sh` syncs every host, .231
    included (on .231 it also installs `fleet-update-public-search.timer`).
  - `rotate-mullvad.sh` `pin`/`city` run from each env's own worktree.
  - `rebuild-ask.sh` exits 1 and skips the reclaim when the app never returns 200
    (`fleet-boot/rebuild-ask.sh:64-67`).
  - The reranker and Whisper are pinned to the 2080 Ti by GPU UUID with `CUDA_VISIBLE_DEVICES`.
  - `/home/nightfury/selfhosted/ingestor` is its own git repo (env files not tracked), and boot
    recovery reconciles all three ingestors. The worker also **backs off** when Ask is
    unreachable (claim failures double the poll interval up to 300 s, ingestor commit
    `b15cb98`); before that a claim error killed the process, and Docker had restarted it more
    than 1,100 times during Ask outages.
  - `UPLOAD_TTL_DAYS` has one parser, `lib/config/upload-ttl.ts` (default 0 = disabled; every env
    sets 14).
  - Model Manager shows `EMBEDDING_MODEL` read-only and its apply API rejects edits to it; the
    running Model Manager was rebuilt on 2026-09-23.
  - **Host Node (resolved 2026-09-24).** Host tooling on .17 runs Node `v20.19.2`, while the app
    containers run `node:22-slim` (`Dockerfile:2,20`). `package.json` `engines.node` now reads
    `^20.19.0 || 22.x`, which states both truths instead of flagging the host as unsupported.
    Production parity is still Node 22 inside the container.

## Tests

### Pre-existing test failures

- **Status: fixed and shipped 2026-09-23** (lab `e36d5a5c`, prod `1ff09c73`). `bun run test` on `flow-design`
  is green: 224 files / 1,844 tests pass, 1 skipped. The stale expectations were updated to the
  intended behaviour (granite4.2, think OFF by default, 20,000-character voice cap, the source
  selector's `Select sources` trigger); `chat-panel` mocks the Discover briefing and the canvas field;
  the SearXNG and Brave-budget tests mock Redis (the engine-health store, `redis`) so they no
  longer hang on `localhost:6379`. No runtime code changed for this. The table below is the
  pre-fix record.

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
  (`app/api/advanced-search/route.ts:540`), i.e. the same `INGEST_API_TOKEN` as the ingest worker
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

- ~~**H2.**~~ **Decided 2026-09-23.** The old `http://searxng:8080` value only resolved (to the
  public SearXNG, through a `shared-infra` alias) while the stacks ran on .231; on .17 it did not
  resolve at all. Prod and staging now fail over to the public SearXNG **explicitly**
  (`SEARXNG_FALLBACK_API_URL=http://192.168.50.231:8127`); lab keeps no fallback. It is a
  fallback only, used when the env's own gluetun/SearXNG fails.
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
- **Status: fixed 2026-09-24.** `MessageActions` renders a muted, text-only "Stopped" pill
  (`components/message-actions.tsx:314,415`) when `AnswerSection` passes
  `stopped={metadata?.stopped === true}`. It shows **live**, because the client flags the message
  on Stop (`markMessageStopped`, via `userStopRequestedRef` in `components/chat.tsx`), and
  **after a reload**, from the persisted flag. The action row now wraps on narrow phones. A Stop
  before any answer text is written saves nothing, so there is no answer and no badge. Details:
  [streaming → Stop](/request-lifecycle/streaming#stop). Test:
  `components/__tests__/message-actions-stopped.test.tsx`.

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
- **Cause found 2026-09-23:** the `ECONNREFUSED` was Ollama listening on loopback only (see
  [Serenity Ollama bound to loopback](#serenity-ollama-bound-to-loopback), now fixed). What
  removed the LAN bind originally (weekly auto-update, WSL restart) is unverified, so keep an eye
  on `[warm]` failures for `.171`. The live `~/ask-fleet-boot.sh` on `.171` is synced by
  `deploy.sh` and warms `granite4.2:8b`. See [runbooks](/operations/runbooks).

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
- **The ingestors** (`ingestor`, `ingestor-staging`, `ingestor-lab`) are all reconciled by
  fleet-boot at boot (since 2026-09-23; before that only the prod one was).
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
  new env needs its own ingestor project. While Ask is down (for example during a rebuild) the
  worker backs off (up to 300 s between claims) instead of crash-looping, so after an Ask outage
  the first claim can lag by up to five minutes.

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
  switching. The Model Manager's `EMBEDDING_MODEL` field is read-only and its apply API rejects
  edits (shipped and rebuilt 2026-09-23, prod `32e0b1d0`).
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
- **Fixed 2026-09-24:**
  - Comments that still named `granite4.1:8b` now name `granite4.2:8b`, the current local model
    (`lib/agents/title-generator.ts`, `lib/voice/spoken-gist.ts`, `docker-compose.lab.yaml`,
    `fleet-boot/keep-warm.sh`, `fleet-boot/README.md`, and the Model Manager's placeholders in
    `selfhosted/model-manager/lib/env-schema.ts`).
  - The lab's copies of `docker-compose.yaml` and `docker-compose.admin-feature.yaml` had drifted
    from the committed prod and staging versions. They were synced: `docker-compose.yaml` now
    matches `dev`, and `docker-compose.admin-feature.yaml` matches `admin-feature`. As a result
    degoog is disabled in every file (`DEGOOG_ENABLED: 'false'`), the staging degoog URL is
    `http://degoog-gluetun-staging:4444`, the staging classifier is `deepseek-v4-pro:cloud` and the
    base `TTS_SERVICE_URL` is `http://192.168.50.17:8890`, as on prod and staging.
  - `package.json` `engines.node` is `^20.19.0 || 22.x` (see
    [fleet automation drift](#fleet-automation-drift)).
  - `scripts/chat-cli.ts` no longer offers `--no-search`, which silently ran a searching
    `balanced` turn (see [evaluation](/operations/evaluation#chat-cli-ts-bun-chat)).

### Lab archive tag missing

- Notes from 2026-08-22 say the pre-merge lab tip was archived as tag `lab-archive-2026-08-22`
  before `dd7e0ca1`. On 2026-09-22 no tags were found. As of 2026-09-24 the tag **is present in
  the local repository** and points at `5f5dbc51`, which is `dd7e0ca1^1` (the merge's first
  parent). It is not on `origin`. Either name recovers the pre-merge lab state.
- **.231 archive branches (2026-09-23).** Before the old checkouts on .231 were deleted, the 42
  commits that existed only there were saved as **local branches** in the repository on .17:
  `archive/231-flow-design-pipeline` (40 commits, last `dfe4a85e`, 2026-07-31) and
  `archive/231-wip-context-latency-budget` (2 commits, last `9eadba76`, 2026-07-28). They are
  lab experiments (pipeline variants, context-budget measurements), not pushed to `origin`. Push
  them, or back up the repository, if they must survive the loss of .17's disk.
