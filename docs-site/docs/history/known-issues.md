---
title: Known issues
---

# Known issues and gotchas

Open problems, pending operator actions and traps a maintainer needs to know about, as of
**2026-10-07**. Each entry gives the **symptom**, its **impact**, a **workaround** and a **fix
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
| [Search hung after the weekly Redis update](#search-hung-after-the-weekly-redis-update) | search / fleet | ~~High~~ fixed 2026-09-27 (lab, staging, prod) | watch the Sunday update log |
| [WSL host hung at boot](#wsl-host-hung-at-boot) | fleet | ~~High~~ fixed 2026-09-29 (unit disabled on the WSL hosts) | done ([D41](/history/decisions#d41-on-wsl-hosts-nothing-that-waits-for-docker-is-enabled-at-boot) rule) |
| [Image pull failures are swallowed by `update-images.sh`](#image-pull-failures-are-swallowed-by-update-images-sh) | fleet | ~~Low~~ fixed 2026-09-29 (all branches) | watch the Sunday log |
| [Pre-existing test failures](#pre-existing-test-failures) | tests | ~~Low~~ fixed 2026-09-23 (all branches) | done |
| [Prod `.env` left `root:root 0644`](#prod-env-left-root-root-0644) | security | Med | ops (one-off `chown` + `chmod`) |
| [RLS guard ignores an unset `ENABLE_AUTH`](#rls-guard-ignores-an-unset-enable-auth) | security | Low | code |
| [Shared secrets across environments](#shared-secrets-across-environments) | security | Med | ops |
| [Secrets to rotate](#secrets-to-rotate) | security | Med | ops |
| [Unauthenticated LAN services](#unauthenticated-lan-services) | security | Med | ops |
| [Ingest and advanced-search share one token](#ingest-and-advanced-search-share-one-token) | security | Med | code + ops |
| [Signed upload URLs not enabled](#signed-upload-urls-not-enabled) | security | Low–Med | ops |
| [Redirect-based SSRF](#redirect-based-ssrf) | security | Low | accepted |
| [Other open audit items](#other-open-audit-items) | security | Low | decision (H2 decided 2026-09-23) |
| [Image attachment forces a generic search](#image-attachment-forces-a-generic-search) | search | Low (URL, attachment-only and "what is this" shapes fixed 2026-09-26 on lab) | code (remaining shapes) |
| [Citation placeholders and out-of-range numbers](#citation-placeholders-and-out-of-range-numbers) | chat | ~~Low–Med~~ fixed 2026-09-26 | watch `citations_unresolved` (now counts out-of-range numbers) |
| [Running-count citation numbers can point at the wrong result](#running-count-citation-numbers-can-point-at-the-wrong-result) | chat | ~~Med~~ fixed 2026-09-27 (lab, staging, prod; ready-made citation handles) | watch (near-miss id copies; deepseek fetch latency) |
| [Reloaded speed-mode answers cited a different page](#reloaded-speed-mode-answers-cited-a-different-page) | chat | ~~Low–Med~~ fixed 2026-09-27 (lab, staging, prod) | done (older saved answers unchanged) |
| [Stopped label not rendered](#stopped-label-not-rendered) | UI | ~~Low~~ fixed 2026-09-24 | done |
| [Chain-of-thought flash in the live stream](#chain-of-thought-flash-in-the-live-stream) | UI | Low | accepted |
| [Old answers keep leaked narration in storage](#old-answers-with-leaked-reasoning-stay-leaked) | data | ~~Low~~ fixed 2026-09-28/29 (staging and prod backfilled, recall re-indexed) | done |
| [An answer with a glued preamble appears late while streaming](#an-answer-with-a-glued-preamble-appears-late-while-streaming) | UI | ~~Low~~ fixed 2026-09-28 (lab, staging, prod) | done (the remaining short delay is by design) |
| [A glued first section can be cut at persist](#a-glued-first-section-can-be-cut-at-persist) | chat | ~~Low~~ fixed 2026-09-29 (lab, staging, prod) | done |
| [A planning draft shows while the answer streams](#a-planning-draft-shows-while-the-answer-streams) | chat | Low (the draft in the saved answer is cut since 2026-10-06 on every env; the 4 stored prod answers backfilled 2026-10-07) | none; the flash while streaming is by design |
| [Snippet citations: wrong page and assembled numbers](#citations-point-at-a-snippet-instead-of-the-fetched-page) | chat | Med | code (open; measured on every turn since 2026-10-01) |
| [todoWrite calls failed validation](#todowrite-calls-failed-validation) | chat | ~~Low~~ fixed 2026-09-29 (lab, staging, prod) | done |
| [Near-duplicate dedup drops templated queries](#near-duplicate-dedup-drops-templated-queries) | search | ~~Low~~ fixed 2026-10-01 (lab, staging, prod; 0 false skips on 446 labelled pairs) | watch `[search-dedup] kept` lines |
| [The fetch-past-the-cap URL limit is advisory](#the-fetch-past-the-cap-url-limit-is-advisory) | search | Low | watch |
| [Parallel search calls can overshoot the round cap](#parallel-search-calls-can-overshoot-the-round-cap) | search | Low (seen: budget 3, 5 searches ran) | code (open) |
| [Older recall chunks lack UUIDs the answer contained](#older-recall-chunks-lack-uuids-the-answer-contained) | memory | Low | optional re-index |
| [Narration the structural rules keep by design](#narration-the-structural-rules-keep-by-design) | chat | Low | by design (watch) |
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
| [Recall is dropped on most turns](#recall-is-dropped-on-most-turns) | memory | ~~Med~~ fixed 2026-09-23 (lab, staging, prod); pool 8 on prod and lab 2026-09-25 | done |
| [Recall misses the budget under rerank contention](#recall-misses-the-budget-under-rerank-contention) | memory | Low | accepted (watch) |
| [Model Manager rewrote `.env` ownership and could not switch features off](#model-manager-rewrote-env-ownership-and-could-not-switch-features-off) | config | ~~Med~~ fixed 2026-09-25 | done (see the prod `.env` entry) |
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
  .171 again (since 2026-09-29 it is disabled there on purpose and runs from `fleet-boot.timer`
  after boot, see [WSL host hung at boot](#wsl-host-hung-at-boot)), and its synced
  `~/ask-fleet-boot.sh` warms `granite4.2:8b`. A drop-in survives the
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
  researcher is built for the turn (`turnStartedAt`, `lib/agents/researcher.ts:938`), not at the
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
- **Follow-up (done 2026-09-25).** Prod still went over the budget on some turns at pool 10 (one
  5-turn chat: `recall_ms` 1375–2076 ms, 3 of 5 budget hits). A bench of the refetch path on 40
  real prod queries put pool 10 at p50 1365 ms (63 of 80 samples over 1.2 s) and pool 8 at p50
  1088 ms (0 of 80), with the same injected set on 40 of 40. **Prod** (`ask-prod/.env`, applied
  through the Model Manager) and **lab** (`docker-compose.lab.yaml`, lab `8b6103e9`) now set
  `RECALL_RERANK_POOL=8`; staging runs the code default, 10. A 4-turn prod chat afterwards had
  `recall_ms` 1080–1342 ms, 0 budget hits and recall injected on all 4. Details:
  [pool 10 → 8](/knowledge/memory-recall#recall-pool-8). What remains is contention, below.

### Recall misses the budget under rerank contention {#recall-misses-the-budget-under-rerank-contention}

- **Symptom.** `recall_budget_hit=true` on a turn whose `recall_ms` is well above the ~1.1 s the
  refetch path normally takes, usually while another turn is searching.
- **Cause.** The reranker (Qwen3-Reranker-8B on the .17 2080 Ti) is shared by recall, upload/URL
  RAG and web-search rerank. With a search-sized rerank in flight, the GPU interleaves the two
  requests and recall finishes late. Measured 2026-09-24: recall missed the 1.5 s budget in 11 of
  12 trials under that contention, at pool 8 and pool 10 alike.
- **Impact (Low).** That turn answers without past-conversation context; nothing breaks, and the
  recall work completes in the background (`recall_ms` still records its true cost).
- **Why it is accepted.** The pool size cannot fix it (both sizes miss), and raising
  `RECALL_BUDGET_MS` would add the wait to time-to-first-token on exactly the busy turns.
  Removing it needs a second reranker (GPU or instance) for recall, or a reranker service that
  schedules small requests ahead of large ones. Neither exists.
- **Watch.** The share of non-gated turns with `recall_budget_hit=true` on prod `[latency]`
  lines. A rise on quiet turns (no concurrent search) is a different problem: check the
  reranker's health and model first.

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
  1. `lib/tools/fetch.ts:687,760` echoes the call's `toolCallId` in a successful fetch result
     (a failed fetch has nothing to cite and gets none).
  2. `stripCitationAnchorsFromHistory` (`lib/streaming/helpers/strip-citation-anchors-from-history.ts`)
     removes anchors from **prior** assistant turns before they reach the model. It runs in
     `create-chat-stream-response.ts:385` and `create-ephemeral-chat-stream-response.ts:132`. The
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
  port. A rate that stays near the old level on live turns means a cause is still missing. Until
  2026-09-26 the counter did not see out-of-range numbers on a real id. It does now, so lines
  from builds with that fix report a **higher** `citations_unresolved` for the same answers;
  compare rates only between lines from the same build. See
  [Citation placeholders and out-of-range numbers](#citation-placeholders-and-out-of-range-numbers).
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
    included (on .231 it also installs `fleet-update-public-search.timer`). **Superseded
    2026-09-29:** enabling it into `multi-user.target` deadlocked Serenity's boot, so on the
    WSL hosts (.17, .160, .171) it is now disabled and runs from `fleet-boot.timer` after boot;
    only .231 has it enabled ([WSL host hung at boot](#wsl-host-hung-at-boot)).
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

The first three entries were found on 2026-09-25. The rest come from the 2026-08-09 and
2026-09-14 audits, which judged the public surface **strong** (no critical or high finding).
What remains is LAN-local or operational. A turnkey
runbook exists outside the repo at `/home/nightfury/selfhosted/security-runbook.md` (no secret
values in it). Details: [security](/infrastructure/security).

### Prod `.env` left `root:root 0644` {#prod-env-left-root-root-0644}

- **Symptom.** `stat -c '%U:%G %a' /home/nightfury/selfhosted/ask-prod/.env` prints
  `root:root 644` instead of `nightfury:nightfury 600`. Checked on 2026-09-25 after the fix below
  was deployed: still `root:root 644`.
- **Cause.** The Model Manager runs as root in its container. Until 2026-09-25 its atomic write
  created a new temp file and renamed it over `.env`, so the result was owned by root with the
  umask's default mode. An apply on 2026-09-25 turned prod's `nightfury:nightfury 0600` file into
  `root:root 0644`, i.e. world-readable. Only the parent directory's mode (`/home/nightfury` is
  0700) keeps other local users out; a file holding every prod secret must not rely on that.
  The owner `nightfury` also can no longer edit it without `sudo`. See
  [Model Manager rewrote `.env` ownership](#model-manager-rewrote-env-ownership-and-could-not-switch-features-off).
- **Why the code fix does not repair it.** The fixed writer **preserves whatever owner and mode
  the file already has**. It does not know what the file "should" be, so a file damaged by the
  old build stays damaged through every later apply.
- **Fix (one-off, on .17).**
  ```bash
  cd /home/nightfury/selfhosted/ask-prod
  sudo chown nightfury:nightfury .env && sudo chmod 600 .env
  stat -c '%U:%G %a' .env        # expect nightfury:nightfury 600
  ```
  No recreate is needed (the container reads its env at creation, not the file's mode). Check
  the backups too: `stat -c '%n %U:%G %a' .env.bak.*` must show `600` for every file.

### RLS guard ignores an unset `ENABLE_AUTH` {#rls-guard-ignores-an-unset-enable-auth}

- **Where.** `lib/db/index.ts:98` enables the fail-closed RLS guard only when
  `process.env.ENABLE_AUTH === 'true'`. The rest of the app treats **unset** as auth **on**: it
  enters anonymous mode only for the literal `false` (`lib/auth/get-current-user.ts:21`,
  `lib/supabase/middleware.ts:82`, `app/page.tsx:12`).
- **Impact (Low today).** With `ENABLE_AUTH` unset, the app would require logins but would
  **not** refuse to serve when its database role can bypass RLS, which is the one case the guard
  exists for (see [security › row-level security](/infrastructure/security#row-level-security)).
  It does not bite any current stack: the base `docker-compose.yaml:21` pins
  `ENABLE_AUTH: 'true'` (prod), the staging overlay sets `${ENABLE_AUTH:-true}`
  (`docker-compose.admin-feature.yaml:15`) and the lab sets `'false'` on purpose. A stack started
  without those compose files, or a future compose edit that drops the pin, would expose it.
- **Fix sketch.** Make the guard match the app: `const authEnabled = process.env.ENABLE_AUTH !== 'false'`,
  with a test for the unset case. Not done yet.

### Model Manager rewrote `.env` ownership and could not switch features off {#model-manager-rewrote-env-ownership-and-could-not-switch-features-off}

- **Found 2026-09-25, fixed the same day** (lab `d105bc7e`, staging `36ad4f0f`, prod branch
  `f3592665`; the running Model Manager image was rebuilt from the staging worktree on
  2026-09-25).
- **Ownership.** Every write (apply, restore) created a temp file as root and renamed it over
  `.env`, leaving `root:root` with the umask default mode. Now `writeFileAtomic`
  (`selfhosted/model-manager/lib/env-io.ts:49-84`) creates the temp file exclusively at no
  broader than 0600, chowns and chmods it on the open descriptor to the original file's owner
  and mode, fsyncs, then renames. Backups are always 0600 and owned like `.env`. Details:
  [Model Manager › file ownership and mode](/infrastructure/model-manager#file-ownership-and-mode).
- **Kill switches.** `RECALL_ENABLED`, `MEMORY_ENABLED` and `OLLAMA_SEARCH_ENABLED` are turned
  off only by the literal `off`, but the switch wrote `false`, which the app reads as **on**. It
  also showed an unset flag as "Disabled" while the app treated it as enabled. The switch now
  writes `on`/`off`, the validator rejects `false`, and an unset flag shows the app's real
  default with "(default)". Details:
  [Model Manager › boolean switches](/infrastructure/model-manager#boolean-switches).
- **Residual.** The prod `.env` damaged before the fix still needs the one-off repair above.

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

- **Symptom.** `/api/advanced-search` authenticates with `checkIngestAuth` (POST
  `app/api/advanced-search/route.ts:586`; the Redis probe `GET`, added 2026-09-27, at `:543`),
  i.e. the same `INGEST_API_TOKEN` as the ingest worker endpoints.
- **Impact.** Anyone who can call search can also call the RLS-bypassing ingest file endpoints, and
  the reverse.
- **Fix sketch.** A small code change: a separate `ADVANCED_SEARCH_API_TOKEN` read by a sibling
  of `lib/utils/ingest-auth.ts`, passed by `lib/tools/search.ts`. Ship it together with the per-env
  secret split. It was flagged as awaiting the owner's go-ahead. The probe in
  `fleet-boot/update-images.sh` (`PROBE_JS`) reads `INGEST_API_TOKEN` from the app container's
  environment, so it would have to read the new name too.

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

### Image attachment forces a generic search

- **Symptom.** Since every question searches
  ([D37](/history/decisions#d37-always-search-every-question)), a message that was only an image
  plus "what is this?" got a forced first search for "What is this?". The classifier sees only
  the message **text** (`buildConversationTranscript` → `getTextFromParts`,
  `lib/agents/query-classifier.ts:312-330`), so it cannot write a query about the image.
- **Related shapes, same cause.** A message with a URL bypassed the classifier, and the forced
  query was the text around the URL with the URL removed: "summarise this https://…" searched
  "summarise this", overriding the prompts' "a URL: fetch it first" rule. An attachment with
  **no** text reached the classifier as an empty message, and the classifier (told never to
  return an empty query) invented one. A contextual follow-up in speed mode or on Retry is
  searched unresolved, because those paths skip the classifier.
- **Impact.** One wasted search round (the advanced one on balanced/quality) and a few seconds of
  latency; the results are irrelevant, and the addendum tells the model not to cite irrelevant
  results. The image is still read by a vision model or the ingestor, and a URL is still read by
  `fetch` or the attached-source path. No wrong answer has been traced to it.
- **Status: URL, attachment-only and attachment-reference shapes fixed 2026-09-26 (lab).**
  `detectUserSuppliedSource` (`lib/agents/always-search.ts:118-137`) reads the latest message's
  parts and cancels the forced search when it carries a URL (inline or a link chip), an
  attachment with no typed text, or an attachment whose text only points at it
  (`isAttachmentReferenceOnly`, `:183-193`: a closed English word list, at most 10 words). The
  turn stays `research` with search available; `[latency]` logs `forced_search:false` and
  `forced_skip` with the reason. Lab browser check: "summarise this
  https://en.wikipedia.org/wiki/User_Datagram_Protocol" → `forced_skip:"url"`, one `fetch`, no
  search.
- **Still open.** An attachment with a real question ("is this mushroom safe to eat?") is
  force-searched on its words alone, so that first search can be generic; a non-English pointer
  ("¿qué es esto?") is treated as a question; speed-mode and Retry follow-ups are searched
  unresolved.
- **Workaround.** Type a real question with the image ("what bird is this, it was in my garden in
  Oregon").
- **Fix sketch.** Give the classifier the attachment's ingest caption so it can write a real
  query for the remaining shapes. Measure with judged answers, not search counts
  ([D4](/history/decisions#d4-judge-answers-not-source-counts)).

### Citation placeholders and out-of-range numbers

- **Symptom.** Seen in the D37 lab A/B (2026-09-26) with kimi-k2.6: answers cited the literal
  placeholders from the prompt's citation examples (`<id-A>` … `<id-E>`, as in `[2](#<id-A>)`),
  wrapped a correct id in the same template syntax (`<id-470411cd-…>`), or used a number beyond
  what a call returned, for example `[2]` or `[3]` on a one-page `fetch`, which has one result. All
  three render as nothing, so the claim ends up uncited.
- **Cause.** Three defects, all in the pre-fix code (`git show dbbbc376`):
  1. **Copyable placeholders.** Every citation example in the speed and balanced prompts used
     `<id-A>` / `<id-B>`. The prompts also showed example ids (`mK3pQr7sT9uV2wX4`,
     `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`), and before 2026-08-02 (`f1652eab`) others such as
     `I8NzFUKwrKX88107`. Models copied them verbatim.
  2. **Two numbering schemes.** The renderer reads `[N](#id)` as **result N of that call**. The
     balanced prompt said the same ("the result order within each search"), but the speed prompt
     said "Each unique toolCallId gets ONE number … Assign numbers sequentially (1, 2, 3...) to
     each unique toolCallId as they appear in your response", and its own format example
     (`[1](#<id-A>)` then `[2](#<id-A>)`) broke that rule. Many models numbered sources as a
     **running count across the answer**: a fetch cited third became `[3](#<fetch id>)`, out of
     range.
  3. **The audit undercounted.** `auditCitations` checked only that an anchor's id belonged to
     the turn, so a real id with an out-of-range number was scored as resolved although it
     rendered nothing.
- **Measured** (replay of stored answers from the last 60 days through the old and new
  resolver). Prod: 88 answers with citations, 1,705 anchors. Lab: 286 answers, 4,219 anchors.
  - Placeholder copying on prod was only the old example ids (17, all pre-2026-08-02 answers by
    glm-5.2) and one literal `toolCallId`. On the lab kimi-k2.6 copied `<id-A>`…`<id-E>` (21
    anchors) and wrapped a real id (7).
  - The audit agreed with rendering in 333 of 374 messages before the fix, 374 of 374 after.
- **Status: fixed 2026-09-26** (lab `dbbbc376`; cherry-picked to `dev` as `0bd8f8cc` and to
  `admin-feature` as `7af2beff`).
  1. **One resolver.** `resolveCitationAnchor` (`lib/utils/citation.ts:376-411`) decides every
     anchor, and `processCitations` (rendering, `:845-869`), `auditCitations` (telemetry,
     `:450-475`) and `extractCitedSourceUrls` (`[cite-urls]`, `:557-571`) all call it, so the
     counter reports exactly what the reader sees. It repairs an anchor only when the intended
     source is unambiguous: a real id of this message wrapped in `<id-…>` / `<…>` is unwrapped
     (`unwrapTemplateId`, `:148-154`); a placeholder resolves only when the message made exactly
     **one** citable call (`isPlaceholderAnchorId`, `:128-139`); a number past the end of a fetch
     whose output holds exactly one page, and is not a `Fetch failed:` result, resolves to that
     page (`resolveWithinCall`, `:317-351`). Everything else is still dropped, and nothing is
     resolved across turns
     ([D36](/history/decisions#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)).
  2. **One numbering rule in every prompt.** `getCitationFormatGuidance()`
     (`lib/agents/prompts/search-mode-prompts.ts:107-124`) is shared by the speed prompt (`:208`)
     and the balanced prompt (`:403`), which quality mode extends: N is the 1-based position of
     the source in **that call's** `results`, restarting at 1 for every call, and a one-page
     fetch is always `[1]`. The worked example uses two realistic ids and says they must never
     be written. All `<id-*>` placeholders are gone from the prompts. The forced-search addendum
     (`FORCED_SEARCH_PROMPT_ADDENDUM`, `lib/agents/always-search.ts:319-322`) no longer shows a
     `[n](#toolCallId)` example; it points at the citation format above it.
     **Since 2026-09-27 this counting guidance is the `CITATION_HANDLES=off` text only.** With
     the flag on (the default) the model no longer works N out: every result it sees carries a
     ready-made `cite` string to copy
     ([D38](/history/decisions#d38-ready-made-citation-handles)).
  3. **Honest audit.** `citations_unresolved` now counts every anchor that renders nothing,
     including out-of-range numbers, and `citations_recovered` covers every repair. Expect
     `citations_unresolved` to be higher than on older builds for the same behaviour
     ([telemetry](/operations/telemetry#tokens-citations-and-totals)).
- **Effect** (same replay). Visible citations on prod 1,460 → 1,470 (+10, all too-high numbers
  on one-page fetches, by deepseek-v4.1-flash); on the lab 3,880 → 3,925 (+38 one-page fetch,
  +7 wrapped id). No citation was lost and no rendered link changed. None of the 18 copied
  placeholders on prod and none of the lab's 21 lettered ones was recovered; they stay dropped
  (a placeholder resolves only in a turn with one citable call, because with several, which call
  was meant is unknown).
- **Not repaired by the resolver.** A number that is **in range** but means "my Nth source"
  renders a real, different result of that search. That was the larger remaining problem, fixed
  at the source on 2026-09-27:
  [Running-count citation numbers can point at the wrong result](#running-count-citation-numbers-can-point-at-the-wrong-result).
- Tests: `lib/utils/__tests__/citation.test.ts` ("resolveCitationAnchor repairs", "audit,
  rendering and cited URLs agree") and `lib/agents/prompts/__tests__/search-mode-prompts.test.ts`
  ("citation examples match what the renderer resolves": no copyable placeholder or retired
  example id, one numbering scheme, and every non-WRONG example anchor renders).

### Running-count citation numbers can point at the wrong result

- **Symptom.** A citation chip links to a real page from the turn's search, but not to the page
  the sentence came from. Nothing looks broken, so users cannot tell.
- **Cause.** The same running-count numbering as above. A model that numbers its sources 1, 2, 3
  … across the whole answer and writes `[5](#<search id>)` meaning "my fifth source" gets that
  search's **fifth result**, which is a valid anchor for a different page. A too-high number is
  dropped; an in-range one renders the wrong source. The model had to count: each call's results
  reached it as a bare JSON array, and the renderer reads N as a position in that array.
- **Impact before the fix** *(heuristic estimate, not a judged sample)*. On the 60-day replay, 22
  of 88 prod answers and 38 of 286 lab answers show the running-count pattern, and about 459 prod
  anchors likely point at the wrong page. This is the failure D36 calls worse than a missing
  citation: it is confidently wrong and invisible.
- **Why the renderer cannot fix it.** An in-range `[N](#id)` is a well-formed anchor for result
  N. Nothing in it says the model meant something else, so any rewrite would be a guess.
- **Status: fixed 2026-09-27** (prod `8878a42d`, lab `48cc3938`, staging `696bd454`). The
  2026-09-26 prompt rule alone did not hold: on the lab it still failed on 11 of 19 citations in
  one turn. Every search result, fetched page and attached-document excerpt the answering model
  sees now carries its finished citation, `"cite":"[N](#<toolCallId>)"`, with N exactly what the
  renderer resolves, and the prompts say to copy it and never compute, renumber or edit a
  citation. Flag `CITATION_HANDLES`, default on; only the literal `off` disables it, per call, so
  a container recreate reverts it without a rebuild. Mechanism, cost and revert:
  [D38](/history/decisions#d38-ready-made-citation-handles).
- **Measured** (lab A/B, same image, arms switched by env; 4 multi-source first-turn questions ×
  2 models per arm; a blind support judge, `deepseek-v4-pro:cloud`, read the claim, the sentence
  before it and the stored source text; 16+ judgements checked by hand). Unsupported citations
  (the cited page does not back the claim):

  | Model | Handles off | Handles on |
  |---|---|---|
  | deepseek-v4.1-flash | 64.0 % | 11.0 % |
  | kimi-k2.6 | 47.8 % | 18.7 % |

  On was lower in all 8 question × model pairs (one-sided sign test p ≈ 0.004). Every citation in
  the on arm was an exact copy of a handle (0 out of range). Most unsupported citations in the off
  arm had their specifics on **another** result of the same turn (deepseek 62 of 80, kimi 28 of
  32), which is the wrong-page failure this entry describes. The unsupported citations left in
  the on arm are mostly wrong attribution or the model's own knowledge. A pairwise answer judge
  (both orderings) found no quality regression: on 4 wins, off 2, 2 ties, and both off wins came
  from content errors, not citations.
- **Caveats.** Recall was on, so off-arm turns could recall on-arm answers. Excluding
  near-copied claims, the gap holds (deepseek 11.1 % vs 67.6 %, kimi 17.4 % vs 56.8 %), and so
  does a comparison restricted to search results (deepseek 18.8 % vs 64 %, kimi 19.1 % vs
  46.3 %). No counter sees this failure, before or after: `citations_unresolved` cannot, because
  a wrong-page anchor resolves. Keep judging support rates
  ([D4](/history/decisions#d4-judge-answers-not-source-counts)).
- **Follow-ups.**
  1. **Near-miss id copies.** kimi-k2.6 lost 3 citations in the on arm by copying the 36-character
     id with one character missing. The resolver had no typo repair, so a near-miss rendered as
     nothing and counted in `citations_unresolved`. The 60-day replay showed the same shape before
     handles: 12 anchors in 2 messages within 1–2 characters of a real id. **Since 2026-10-06**
     (lab, staging and prod) an id one character off exactly one call of the turn
     resolves (`id-typo`), and so does an id shortened to at least 8 hex characters that starts
     exactly one call (`id-prefix`, the glm-5.3-flash shape); both count as
     `citations_recovered`. An id two characters off is still dropped
     ([D44](/history/decisions#d44-shortened-and-one-character-off-citation-ids-resolve)).
  2. **deepseek fetch latency (open).** In the A/B, deepseek-v4.1-flash fetched a page on 4 of 4
     turns with handles on and 0 of 4 with them off, about +30 s per turn. This is confounded
     with recall and not explained. Watch prod `tool_calls` and the share of turns with
     `fetch_ms` for that model ([telemetry](/operations/telemetry#tokens-citations-and-totals)).
  3. `scripts/eval/run-eval.ts` scores citation validity by id only (`scoreCitations`,
     `:405-429`): it ignores N and applies none of the renderer's repairs, so it cannot see
     this issue ([evaluation](/operations/evaluation)). The A/B above used a separate
     support judge; it is not in `scripts/eval/`.
  4. The `FLOW_VARIANT` experiment prompts replace the mode prompt and carry their own
     `CITATION_RULES` (`lib/agents/flows/variants.ts:52-59`), which neither state the numbering
     rule nor mention the `cite` field (the tool outputs still carry it). No env sets
     `FLOW_VARIANT`, so every env runs `baseline` (the mode prompts); this matters only if a
     variant is revived.
  5. With `CITATION_HANDLES=off` everything above returns: the counting prompt, the attached-sources
     clause with `[1](#<toolCallId>)`, `<first-id>` and `<second-id>` (a verbatim copy renders
     only when the turn made exactly one citable call), and too-high numbers on a one-result
     **search** (6 anchors in the replay; the resolver's out-of-range rule covers fetches only).
  6. **Long research loops still drift (open).** With handles on, quality turns with 12+
     search/fetch calls cited much less (0.95 anchors per 1,000 characters against 3.1–3.6 for
     shorter turns in stored lab history). In the 2026-09-29 A/B an 18-call turn wrote no
     citation at all and a 15-call turn went back to a running count with a reference list. An
     answer-step reminder was built and measured but did not stop it and is off
     ([D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap)).
- Tests: `lib/utils/__tests__/citation-handles.test.ts` (every handle of a 27-result search
  resolves to its own result; positions survive results without a handle),
  `lib/tools/__tests__/search-to-model-output.test.ts`,
  `lib/tools/__tests__/fetch-citation-handles.test.ts`,
  `lib/streaming/helpers/__tests__/document-retrieval-part.test.ts` (each also pins the
  flag-off output), `lib/agents/prompts/__tests__/search-mode-prompts.test.ts` ("citation
  guidance under CITATION_HANDLES") and `lib/agents/__tests__/citation-handles-e2e.test.ts`
  (copied handles render their own result; nothing stored carries a `cite`).

### Reloaded speed-mode answers cited a different page

- **Symptom.** A citation that pointed at the right page while the answer streamed pointed at a
  different page of the same search after a reload.
- **Cause.** Before saving, `rehydrateFullContent` (`lib/search/rehydrate-full-content.ts`)
  swaps the full page text back into search outputs whose live results the model saw as
  excerpts. It replaced the whole `results` list with the recorded full list. In practice only
  the speed fast path records one (the advanced route's `fullResults` needs
  `SEARCH_EXCERPTS_ENABLED`, off everywhere), and it records the list **before** the researcher's
  per-turn URL dedup (`wrapSearchToolWithDedup`, `lib/agents/researcher.ts:287-384`) removed
  results an earlier search of the turn had already returned. So on a speed turn with more than
  one search, a later search's saved list could contain the removed duplicates again, every
  position after them shifted, and a stored `[N](#id)` resolved to a different result.
- **Status: fixed 2026-09-27** (prod `0ca166fe`, lab `8a67e3cd`, staging `3402bc5d`). Full
  content is now swapped in **by URL**, keeping the live results' order and length
  (`lib/search/rehydrate-full-content.ts:44-57`); a live result with no recorded full text keeps
  its excerpt. Answers saved before the fix keep the list they were saved with; nothing rewrites
  stored messages.
- **Why it matters beyond speed mode.** The order of a call's `results` is part of the citation
  contract ([pipeline › Return](/search/pipeline#return)): anything that rewrites a tool
  output between the model and the database must keep positions.
- Test: `lib/search/__tests__/rehydrate-full-content.test.ts` ("keeps the live order and length
  when the full list is pre-dedup").

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
  answers in July 2026. (The glued seam is the one cut the transform makes in any language,
  because there the persisted cut can be known from a prefix; see
  [the entry below](#an-answer-with-a-glued-preamble-appears-late-while-streaming).) Persisted messages are cleaned by the persist-time strippers. Since
  2026-09-28 the renderer also applies those persist-time rules to the message while it streams
  (`narrationCleanView`, `components/render-message.tsx:158`), so only a leak that neither the
  live transform nor the persist-time rules recognise can flash. See
  [D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live).
- **Fix sketch.** Add the new starter phrases to `NARRATION_STARTERS` with tests. Don't loosen the
  buffer ceiling without a corpus. If leaks become frequent, re-evaluate
  [targeted reasoning](/history/decisions#d18-targeted-reasoning-reasoning-only-on-research-turns).

### Old answers keep leaked narration in storage {#old-answers-with-leaked-reasoning-stay-leaked}

- **Symptom (before the backfill).** Answers saved before a narration rule existed still held
  it in Postgres: status notes written before a tool call (in any language, or English with
  unlisted wording), a long reasoning preamble or stray `</think>` from before 2026-09-17
  (`0290896c`), and a preamble glued to the answer heading (`…câu trả lời.## `) from before
  2026-09-28 (`48d5b06d`).
- **Display fixed 2026-09-28.** Every reader applies the persist-time cleanup when it reads a
  message: the chat view, the copy shortcut and the action-row copy, the history fed back to
  the model and the classifier (logged-in and guest), the spoken gist and search snippets
  ([full list](/search/models-reasoning#narration-read-time)). What stayed affected was
  **keyword search** (sidebar and Library matched words that occurred only in a stored status
  note) and **recall chunks** indexed before 2026-09-28 that kept a glued preamble (on prod,
  the 3 Vietnamese answers of chat `pq6zs7w88m1kmowjdu9udfrw`).
- **Status: fixed in storage 2026-09-28/29** with `scripts/backfill-narration.ts` (prod
  `a59d0c65`, lab `449d8d3e`, staging `736faf57`):
  - **staging:** 99 messages, 242 text-part deletes, 5 rewrites; recall re-indexed for 4
    messages (23 → 14 chunks);
  - **prod:** 92 messages, 177 deletes, 4 rewrites; recall re-indexed for 8 messages
    (68 → 56 chunks); on 2026-09-29 one more prod message was rewritten after a new English
    rule ([D20 › Decision 6](/history/decisions#decision-6-the-glued-seam-wins-at-persist-too)).

  Every changed message reloads through the app's loader equal to what the reader renders
  (verify 100 %), a re-run finds 0 changes, and no recall chunk still contains removed text.
  Numbers, method and backups: [D20 › Backfill](/history/decisions#backfill-2026-09-28-29).
  To run it again: [runbook](/operations/runbooks#re-run-the-narration-backfill).
- **Scope.** The recorded runs covered staging and prod. The lab has a backup file from
  2026-09-28 but no apply report. After the 2026-09-29 rule, only one prod message needed a
  change. A narration rule added later leaves older stored answers as they are until the
  backfill is run again; the read-time cleanup still hides them meanwhile.
- **Don't use `bun run clean:narration` for this.** `scripts/clean-narration-preambles.ts`
  applies `stripNarrationPreamble` to **every** `type='text'` part, user messages included
  (`:37-49`); it never drops a status-note part and never re-indexes recall.
- **Regenerating an answer** also replaces it with one saved and indexed under the current rules
  (its old recall chunks go with the old message, `conversation_chunks.message_id` is
  `ON DELETE CASCADE`, `lib/db/schema.ts:501-503`).

### An answer with a glued preamble appears late while streaming {#an-answer-with-a-glued-preamble-appears-late-while-streaming}

- **Symptom (before the fix).** When a model glues narration to the answer's heading
  (`…breakdown.## Title`, `…câu trả lời.## Title`), nothing was shown for that part at first.
  How long depended on the preamble:
  - **An English-looking preamble** kept the live transform buffering, waiting for a line-start
    heading that a glued `## ` never provides (`findHeadingMatch`), so the **whole answer** was
    held until the part ended and then appeared at once. Lab chat `bllkvux84ck1uz3wwrwnydg5`
    (deepseek-v4-pro): 4,916 characters, about 72 s with nothing on screen after the last tool
    call.
  - **A longer non-English preamble** is released by the transform after ~64 characters. The
    render view cuts it once the answer body outweighs it, and the first-token rule
    (`components/render-message.tsx:237`) hides the part until then, so the answer appeared a
    few hundred characters into the stream.

  An earlier version of this entry described only the second case and understated the worst
  case.
- **Status: fixed 2026-09-28** (prod `6e19914f`, lab `a3074f86`, staging `951b6a83`;
  [D20 addendum › Decision 5](/history/decisions#decision-5-the-live-transform-cuts-the-glued-seam)).
  The transform now finds the glued seam through the same helpers as the persist rule
  (`findGluedPreambleSeam`, `gluedAnswerOutweighsPreamble`,
  `lib/streaming/helpers/strip-narration-preamble.ts:309,332`) and, as soon as the text after
  the seam outweighs the prefix, emits the answer from its heading and streams the rest
  (`lib/streaming/helpers/smooth-and-strip-narration.ts:98-127`). On a replay of the recorded
  turn the answer starts 792 characters after the seam (after 1,577 of 4,916 characters)
  instead of at the end.
- **What remains, by design.** The answer still appears only once its body outweighs the
  preamble. That is the persist rule's own guard (a long preamble in front of a short answer is
  kept), and releasing earlier could drop text that persist keeps. The delay is at most one
  delta past prefix + 1 characters of answer, and the prefix is at most 2,000 characters. A
  longer non-English preamble still passes through the transform (it is released before the
  seam arrives) and is cut by the render view at the same point. The preamble never flashes
  in either case.
- **Tests.** `lib/streaming/helpers/__tests__/smooth-and-strip-narration-replay.test.ts`
  (replay of the recorded turns) and the glued-seam guards in
  `lib/streaming/helpers/__tests__/smooth-and-strip-narration.test.ts`.

### A glued first section can be cut at persist {#a-glued-first-section-can-be-cut-at-persist}

- **Symptom.** A saved or displayed answer starts at its second `## ` heading; the first
  section is missing.
- **When.** Text shaped `narration.## A … \n## B` that reaches the persist-time cleanup with the
  preamble still in place. `stripNarrationPreamble`
  (now `lib/streaming/helpers/strip-narration-preamble.ts:631-640`) ran the English phrase rule
  first until the fix: it takes `\n## B` as the heading and, when the text before it reads as
  narration, cuts everything up to it, section A included. The glued rule, which would cut at `## A`, runs
  second and finds nothing left to cut. The live transform handles this shape (a seam before a
  later heading wins, `lib/streaming/helpers/smooth-and-strip-narration.ts:100-104`), so it only
  reaches persist when the transform released the text unchanged:
  - the seam stayed undecidable until the part ended (the text after it never outweighed the
    prefix) or the 16,000-character ceiling was reached; or
  - the preamble did not look like narration in its first 64 characters, so the transform
    released it before the seam arrived, and an English narration sentence follows later.
- **Impact.** Low. It needs a glued preamble, English narration in it, a later line-start
  heading, and a turn on which the live cut did not fire. The render view runs the same
  function, so what is shown matches what is saved.
- **Status: fixed 2026-09-29** (prod `d751352d`, lab `0cb22cf9`, staging `95c73f74`;
  [D20 › Decision 6](/history/decisions#decision-6-the-glued-seam-wins-at-persist-too)).
  `stripNarrationPreamble` now asks `gluedSeamLeads`
  (`lib/streaming/helpers/strip-narration-preamble.ts:613-618`) first: a qualifying glued seam
  before the first line-start heading is decided by the glued rule alone, as the live transform
  does, so the phrase rule can no longer cut at `\n## B`. A scan of every stored message on
  prod, staging and lab with the new rules changed exactly 1 message and removed no real
  content. Test: the `## A … \n## B` shape in
  `lib/streaming/helpers/__tests__/strip-narration-structural.test.ts`.

### A planning draft shows while the answer streams {#a-planning-draft-shows-while-the-answer-streams}

- **Symptom.** While an answer streams, the reader first sees an outline of it followed by
  notes on citations and tool-call ids ("Available cite strings (toolCallIds) in this turn…",
  "Related questions spec block? … skip"); a moment later the outline and notes disappear and
  the answer shows from its first heading. On a build without the fix the draft stays: in the
  saved answer, after a reload, in copy and in recall.
- **Cause.** glm-5.3-flash wrote its plan into the final text part and glued the real answer to
  the last note (`…at end.## Why…`). Seen on prod in 4 answers of one chat
  (`mzwbeqoe15wgh12et66fybzo`, 2026-10-06); the drafts were 2.0–15.1 KB. The glued-seam rule
  refuses such a prefix, because it has headings of its own and is longer than 2,000
  characters.
- **Status: the saved and displayed answer is fixed 2026-10-06 on lab, staging and prod** (lab
  `a6a9d6c0`, staging `1a43ef1c`, prod `20cb9cc1`); the 4 stored prod answers were backfilled
  2026-10-07 ([runbook](/operations/runbooks#re-run-the-narration-backfill)). Persist,
  the render view and every other reader cut the draft at the glued seam
  (`stripDraftBeforeRestart`, `lib/streaming/helpers/strip-narration-preamble.ts:571-574`).
  The four conditions, the thresholds and the replay evidence (exactly those 4 answers cut
  across all stored history, 0 elsewhere) are in
  [D20 › Decision 7](/history/decisions#decision-7-a-planning-draft-in-front-of-a-glued-restart-is-cut).
- **What remains, by design: the draft shows while streaming.** The live transform is
  unchanged. An outline draft opens with `## ` like any answer, so the transform could not hold
  it without holding every answer, and the cut depends on text after the seam that has not
  streamed yet. The render view (`narrationCleanView`) shows the draft until the answer after
  the seam has 400 non-space prose characters (`DRAFT_ANSWER_MIN`, `:433`) and, for an outline
  draft, a heading that restates the outline has arrived; then it shows only the answer. A
  heading-less draft that opens with English narration is held by the transform as before and
  appears, already cut, when the part ends.
- **Also not cut:** a draft followed by a proper `\n\n## ` restart instead of a glued one (0
  cases in stored history). There the prompt vocabulary alone would have to decide, and an
  answer about Ask's own citations can use it.
- **Impact.** Low: a flash of scratch notes from a model that writes them; on a build with the
  fix the saved answer is clean.
- **Tests.** `lib/streaming/helpers/__tests__/strip-narration-draft.test.ts` (including the
  live transform passing the draft through unchanged).

### Narration the structural rules keep by design {#narration-the-structural-rules-keep-by-design}

- **Symptom.** A model's process talk still appears in a saved or displayed answer.
- **Cases left alone on purpose** (rules in
  [models & reasoning](/search/models-reasoning#narration-structural-rules)):
  - **Non-English narration before a proper `\n\n## ` heading.** Only the English phrase rules
    look at a preamble separated from the heading by a newline; cutting an unrecognised intro
    paragraph risks eating genuine prose. The 2026-09-28 scan found **0** such cases.
  - **Long or structured status notes.** A non-final part over 600 characters, or with a
    heading, table, code fence, 3+ item list or citation, or longer than the final answer, is
    kept unless it starts with an English narration phrase. The review of stored history found
    **6** such narration parts. After the turn they are hidden anyway (only the last text part
    is the answer); they still reach the history sent to the model and search.
  - **A final answer with fused narration and no heading** (unchanged since D20).
  - **A planning draft followed by a proper `\n\n## ` restart** (since 2026-10-06 a draft
    glued to its answer is cut; 0 cases of the newline shape in stored history). See
    [A planning draft shows while the answer streams](#a-planning-draft-shows-while-the-answer-streams).
- **Impact.** Low.
- **Fix sketch.** Only with a corpus: collect the new shape, add a rule with tests in
  `lib/streaming/helpers/__tests__/strip-narration-structural.test.ts`, and re-run the
  false-positive review before shipping. Don't raise the 600 / 2000 thresholds on a single case.

### Snippet citations: wrong page and assembled numbers {#citations-point-at-a-snippet-instead-of-the-fetched-page}

- **Symptom.** A citation chip opens a real result of the turn's search, but the sentence it
  backs is not in that result's text, which is only a search snippet (at most 1,000
  characters, `SNIPPET_MAX_CHARS`).
- **Measured** (2026-09-30 quality re-test on the lab; each citation judged against
  the stored source text, with the page text of the same URL merged in when the turn had
  fetched it). Citations of a snippet were unsupported **71 %** of the time, citations of page
  text **23 %**. The quality changes of 2026-09-30 make this more visible, because quality turns
  now fetch more ([D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap)).
- **What it is (corrected 2026-10-01).** The first reading, "the model read the fact on a page it
  fetched and cited the snippet of that same page", is rare. All 68 snippet citations judged
  unsupported or partly supported in the re-test cite a URL that was **not** fetched that turn,
  and on prod 1 of 133 snippet citations had its own URL fetched in the same turn. Re-judged one
  by one, against the cited page fetched live and against every other page of the turn:
  - **28 % right for the reader (19).** The snippet itself supports the claim (2), the same page
    was read under another URL (1), or the live cited page supports it (16; caveat: that page was
    fetched one to two days later, and 5 of the 16 are also supported by another page of the
    turn).
  - **32 % the wrong page (22).** Another page of the turn supports the claim and the cited one
    does not. In 21 of the 22 that page was page text: a fetched page or a page crawled in the
    first search.
  - **40 % supported by nothing retrieved (27).** 20 partly supported, 7 not at all; 9 of the 27
    are table rows assembled from several sources.

  So the real problems are **wrong-page attribution** and **numbers the model assembled**; the
  snippet is where they show, not their cause.
- **How common.** Of 567 rendered citations in the re-test, 55 % cite page text, 5 % a snippet
  whose page the turn read, 40 % a snippet only. On prod since 2026-09-28: 290 rendered, 54 %
  page, 46 % snippet only.
- **Visibility.** The anchor resolves (it names a real result of the turn), so
  `citations_unresolved` stays 0. Since 2026-10-01 the `[latency]` line carries
  `citations_snippet`, `citations_snippet_read` and `fetch_pages_uncited`
  ([telemetry](/operations/telemetry#tokens-citations-and-totals)), which track the rate, not
  the support: only a support judge measures that
  ([D4](/history/decisions#d4-judge-answers-not-source-counts)).
- **Impact.** Med: the answer is often right, but its citation does not show where the fact came
  from, and 4 in 10 of the unsupported or partly supported snippet citations back a claim that
  nothing retrieved fully states.
- **Tried and rejected (2026-10-01).** Repeating the cite marker inside page text moved citations
  from snippets onto pages without making them better supported, and broke every anchor in 2 of
  17 answers. Re-pointing each snippet citation to the best-matching page of the turn, replayed
  offline, would have moved 9 of the 16 correct citations to pages that do not support them.
  Details and numbers: [D43](/history/decisions#d43-snippet-citations-measured-not-re-pointed).
  The answer-step citation reminder did not address it either and is off (D40).
- **Fix sketch (open, untested).** Treat the two problems separately: wrong-page attribution
  needs a change in what the model is shown or told about which result holds which fact;
  assembled numbers need the answer to cite every source a derived figure or table row comes
  from, or say that it is derived. Evaluate any model-facing variant first by replaying stored
  turns offline and judging support against every page of the turn, then with a judged lab A/B.
  Do not judge it by `citations_snippet` alone: in the marker experiment a lower snippet share
  came with worse support.

### todoWrite calls failed validation

- **Symptom.** A `todoWrite` call (the quality protocol's task list) failed schema validation as
  a whole, so the task list did not update.
- **Cause.** The input schema required `id` and `timestamp` on every item. Models routinely left
  out `timestamp` (13 of the 14 stored validation failures on prod, staging and lab by
  2026-09-29), and one retry that added timestamps dropped `id`. Neither field is shown in the UI.
- **Status: fixed 2026-09-29** (prod `3e715f2b`, lab `9cb61e63`, staging `5e614b72`). The model's
  input schema (`todoItemInputSchema`, `lib/tools/todo.ts:27-38`) makes both optional, and
  `completeTodos` (`:57-72`) fills them server-side: `id` defaults to the item's 1-based
  position, `timestamp` to the time an earlier `todoWrite` call of the same tool instance recorded for
  that id, else now. Values the
  model sends are kept. The UI reads the input type (`TodoItemInput`,
  `components/todo-list-content.tsx:15`), because a streamed input may still lack them. Tests:
  `lib/tools/__tests__/todo.test.ts`.

### Mobile keyboard / composer on real devices

- **Symptom.** Composer anchoring while typing on phones (`41f8ed8e`) and the click/keyboard timing
  of the mid-stream refresh fixes could only be checked headlessly, not on a real on-screen keyboard.
- **Workaround.** Verify on a device after any change to `chat-panel.tsx` or `chat.tsx`.
- **Fallback plan.** If the caret still drifts, pin the composer to the bottom (chat-app style).
  The empty-state autofocus on touch devices was also flagged as a possible contributor (it pops
  the keyboard on load).

---

## Search, research and recall

### Near-duplicate dedup drops templated queries

- **Symptom.** A quality turn that researched several products with the same query template
  ("X GitHub features license", "Y GitHub features license") got a "Skipped: this search is a
  near-duplicate…" note instead of results for some of them, and the answer covered those items
  from other sources or not at all.
- **Cause.** The in-turn dedup embedded each query and skipped one whose cosine similarity to an
  earlier query of the turn was ≥ `SEARCH_DEDUP_THRESHOLD` (0.92), with nothing else checked.
  Queries that share a long template and differ in one name score above that. In the
  2026-09-29/30 lab A/Bs, 6 of 7 such skips were false positives (for example "Scira" matched
  "Morphic"). Since 2026-09-30 a skip no longer used a search round
  ([D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap)), but the search
  itself was still dropped.
- **How big it was.** Of the 76 skips stored in lab, staging and prod by 2026-10-01, 34 (45 %)
  had dropped a real search: another product, model, version, source or facet (two different
  projects' "GitHub features" queries; a spec query against a price-and-warranty query). On 446
  real query pairs labelled blind by two independent annotators (kappa 0.916; 245 repeats, 115
  drill-downs, 86 different searches), the cosine-only rule made 332 skips, 137 of them not
  repeats: precision 0.587, recall 0.796. No threshold fixes it: among labelled non-repeats,
  11 % of pairs score ≥ 0.97.
- **Status: fixed 2026-10-01** (prod `befe76fe`, lab `e57724a5`, staging `9249eec9`). A skip now
  needs an exact repeat (equal once case, punctuation and quotes are ignored) or a near repeat:
  cosine ≥ 0.90 **and** the later query adds no content word, drops no number other than a year
  and does not reverse the word order around to/from/than (`lib/tools/search/query-dedup.ts`,
  wired at `lib/tools/search.ts:437-517`). On the labelled pairs: 61 skips, all true repeats
  (precision 1.000, recall 0.249). Rule, logs and knobs:
  [pipeline › dedup](/search/pipeline#round-cap); evidence:
  [D42](/history/decisions#d42-near-duplicate-search-skip-only-for-true-repeats).
- **Trade-off, by design.** About three quarters of true repeats now run, and each uses a search
  round (3 in speed and balanced). The answer pays one extra round rather than losing a search it
  needed.
- **Watch.** `docker logs ask 2>&1 | grep '\[search-dedup\]'`: `skipping … (exact)` /
  `(near, cos=…)` are skips, `kept …` lines are searches the old rule would have skipped. A
  `kept` line whose added word is generic (a synonym of "best" or "guide") is a candidate for
  the generic-word list; label a batch first. `SEARCH_DEDUP_TOKEN_GUARD=off` restores the old
  rule exactly; `SEARCH_DEDUP_ENABLED=off` disables the check.
- **Folding quirk — fixed 2026-10-02.** The generic-word list was checked after plurals were
  folded, so `versus`/`docs`/`basics` never matched and an added `news` folded to the generic
  `new` (so "`<topic>` news" could be skipped as a repeat of "`<topic>`"). The list is now stored
  folded and `news` is exempt from folding (`NO_FOLD` in `lib/tools/search/query-dedup.ts`);
  covered by tests in `lib/tools/search/__tests__/query-dedup.test.ts`.

### The fetch-past-the-cap URL limit is advisory

- **What.** After the quality search cap, the notice lets the model fetch "URLs that appeared in
  this turn's earlier search results" (`buildSearchRoundCapNotice`,
  `lib/tools/search-rounds.ts:83-91`; the quality withdrawal note, `buildSearchWithdrawnNote`,
  `:104-113`, says the same). Nothing enforces that: `fetch` accepts any URL. In one lab test
  the model fetched GitHub URLs it had constructed.
- **Bounds that do hold.** The fetch cap (8 calls per quality turn, `lib/tools/fetch-budget.ts`),
  5 URLs per call, 40 s per URL, the SSRF guard, the 100-step ceiling and the 200 s answer
  deadline.
- **Impact.** Low. A constructed URL can 404 (a wasted call) or be a real page the searches did
  not return, which is usually harmless.
- **Fix sketch** (only if it becomes a problem). Record the turn's result URLs (the researcher
  already keeps `seenUrls`) and refuse, past the cap, a fetch of a URL outside that set.

### Parallel search calls can overshoot the round cap

- **Symptom.** A turn runs more searches than its budget. Prod chat `cznh8gc1gz41vq2lwjb560br`
  (mistral-large-4, balanced, `SEARCH_ROUNDS_MAX` 3) ran 5 real searches before the cap refused
  any.
- **Cause.** A check-then-act race in `createSearchTool` (`lib/tools/search.ts`). The budget is
  checked at the top of `execute` (`searchRounds.used >= roundsBudget`, `:383`), but the counter
  is incremented only at `:521`, after the first `yield` (`:432`) and the near-duplicate check's
  embedding call (`await embedTexts`, `:462`). The AI SDK starts the parallel tool calls of one
  step concurrently, so every call that reaches the check before the first increment passes it.
- **Impact.** Low. The overshoot is bounded by the number of parallel `search` calls in the step
  that crosses the budget, and each extra search is a real fan-out and crawl (cost and context,
  not a wrong answer). Once the counter is past the budget, later calls are refused as designed.
- **Not the search loop.** The same prod turn also had 80 further `search` calls refused over
  about 30 steps. That part is fixed separately (2026-10-07, lab, staging and prod): after
  the first refusal `search` is no longer offered, and a model that keeps calling it gets
  answer-only steps ([pipeline › round cap](/search/pipeline#round-cap),
  [D45](/history/decisions#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps)).
  Since the D45 addendum (lab, staging and prod) `search` is withdrawn as soon as the
  shared counter reaches the budget, and the withdrawal line can then show more rounds than the
  budget (`rounds 5/3` in a lab test). The overshoot itself was left as is. The research steps in the UI show
  only the searches that ran; refused calls fold into one "skipped" line.
- **Fix sketch.** Reserve the round synchronously when the check passes (increment before the
  first `yield` or `await`) and give it back when the near-duplicate check skips the search,
  which must not use a round
  ([D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap)). Add a test that
  starts several calls of one step concurrently.

### Older recall chunks lack UUIDs the answer contained

- **Symptom.** Recall does not match a past answer by a UUID it contained (a GUID in a
  configuration answer, the id inside an image URL), although the answer shows it.
- **Cause.** Before 2026-09-29 the recall indexer stripped **every** UUID from answer text, to
  remove bare tool-call ids. Of 33 UUIDs found outside citation markers in stored answers on
  prod, staging and lab, 32 were real content (for example a Hyper-V `VMCreatorId` and the UUID
  in `/uploads/asset/file/<uuid>/…`).
- **Status: fixed for new indexing 2026-09-29** (prod `dfccc08c`, lab `418193e9`, staging
  `f197f24a`). `extractIndexableText` strips only the message's **own** tool-call ids and a
  UUID in citation-anchor position (`#<uuid>`), and indexes any other UUID
  (`lib/memory/extract-indexable-text.ts:56-74`). The live indexer passes each part's
  `toolCallId` (`lib/streaming/create-chat-stream-response.ts:1194`), and the recall backfill's
  query returns `tool_tool_call_id` (`lib/db/recall-actions.ts:196-201`).
- **Still affected.** 25 older messages on prod and staging keep chunks indexed under the old
  rule until they are re-indexed. Impact is low: only a search for that UUID misses them.
- **Fix sketch.** Delete those messages' `conversation_chunks` rows and run the recall backfill
  ([memory & recall › backfill](/knowledge/memory-recall#backfill)), which fills messages that
  have no chunks.

---

## Fleet and operations

### WSL host hung at boot

- **Symptom (2026-09-29, Serenity .171).** After a reboot the WSL distro never finished booting:
  `systemctl` reported "Bootup is not yet finished" for about 8 minutes, and Docker Desktop's
  WSL integration never came up (its `backend.sock` never appeared), so no container started.
- **Cause.** Since 2026-09-23 `fleet-boot/deploy.sh` enabled `ask-fleet-boot.service` into
  `multi-user.target` on every host. The unit waits up to 120 s for Docker, but on WSL Docker
  Desktop injects its integration only after systemd reports boot finished: each waited for
  the other.
- **Recovery that day.** `wsl --shutdown` and a Docker Desktop restart from Windows. With the unit
  disabled, userspace boot on .171 takes 1.6 s.
- **Status: fixed 2026-09-29** (prod `bbf936f8`, lab `8d59d2f1`, staging `d0fdba20`). `deploy.sh`
  leaves the unit **disabled** when `systemd-detect-virt --container` prints `wsl`
  (`fleet-boot/deploy.sh:44-53`) and enables it only on bare metal (.231). On the WSL hosts
  `fleet-boot.timer` (`lan_automation`, `OnBootSec=75s`) pulls it in after boot. Checked
  2026-09-30 on all four hosts. Rule and history:
  [D41](/history/decisions#d41-on-wsl-hosts-nothing-that-waits-for-docker-is-enabled-at-boot);
  runbook: [WSL host hangs at boot](/operations/runbooks#wsl-host-hangs-at-boot).

### Search hung after the weekly Redis update

- **Symptom (2026-09-27, about 11:30 → 20:03 UTC).** On prod and staging, balanced and quality
  questions never got an answer: the first search spun and the turn ended after about 300 s
  with nothing written. Speed-mode and no-search turns worked, the containers stayed healthy and
  the homepage answered 200. Prod's `latency:log` holds two such turns (`blank_abort:true`,
  `abort_silence_ms` 300 636 and 301 002, `steps:1`, `tool_calls:1`); guest turns write no
  `[latency]` line, so the count is a floor.
- **Cause.** The weekly `fleet-update-ask` run (04:30 PDT) pulled a new `redis:alpine` and
  recreated `ask-redis`, `ask-gluetun` and `ask-searxng` (prod, 11:30:37–39 UTC) and their
  `-admin-feature` twins (staging, 11:31:14–15 UTC). It never touches the app, which kept its
  connections. Seven modules held a module-level node-redis client with no `'error'` listener;
  on the disconnect node-redis 4.7.1 re-emitted the socket error, the emit threw
  (`uncaughtException: Socket closed unexpectedly`, 11:30:38 UTC) before the reconnect was
  scheduled, and the client stayed open-but-never-ready with its default offline queue holding
  every later command. `/api/advanced-search` awaits a cache `GET` first, so it never sent
  headers, and the search tool's call to it had no timeout: each turn waited out undici's
  300 s headers timeout. Mechanism in detail:
  [runbook](/operations/runbooks#search-hangs-after-a-redis-restart).
- **Why no check caught it.** The update verified the app homepage, the SearXNG UI (both 200) and
  the VPN egress, and printed `All stacks updated and verified.` for every stack
  (`/home/nightfury/selfhosted/logs/update-ask.log`). None of those touch the search route's
  Redis client.
- **Why the lab was unaffected.** Its image pull failed that morning (next entry), so nothing on
  the lab was recreated.
- **Mitigation.** `docker restart ask ask-admin-feature` at about 20:03 UTC.
- **Status: fixed 2026-09-27** (lab `a9c5914a`, prod `2f5eac13`, staging `c0df517f`, deployed
  to prod and staging about 20:45 UTC):
  - `lib/redis/local-redis.ts` is the one way to get a local Redis client: an `'error'`
    listener that logs once per state change, `disableOfflineQueue`, bounded connect and
    reconnect backoff, a 1 s bound on every command, and dead clients rebuilt. All seven
    modules use it; each caller's outage behaviour is unchanged
    ([data layer](/infrastructure/data-layer#redis-clients),
    [D39](/history/decisions#d39-every-local-redis-client-goes-through-local-redis-ts)).
  - The search tool bounds its call to `/api/advanced-search` (20 s to response headers, 180 s
    in total) and falls back to a basic SearXNG search on timeout
    ([pipeline](/search/pipeline#advanced-search-deadline-and-fallback)).
  - `GET /api/advanced-search` is a token-gated Redis probe; `update-images.sh` restarts the
    app when a sidecar changed under it, then runs the probe
    ([fleet scripts](/operations/fleet-scripts#update-images-sh)).
  - Verified on the lab by recreating `ask-redis-lab` under the running `ask-lab` (20:33 UTC):
    `[redis:advanced-search] reconnected`, no uncaught exception, and a balanced question
    answered normally. The probe returned 200 on prod and staging after the deploy.
- **Watch.** The first Sunday run with the new script (2026-10-04): its log should show
  `sidecars changed under the running app; restarting …` (or `no sidecar changed`) and
  `ok   search redis probe   200 …` for each Ask stack.
- **Evidence note.** The pre-fix container logs were discarded when the fixed images were
  deployed (the app containers were recreated at 20:41 and 20:45 UTC). What survives: the
  update log, the `[latency]` lines in `latency:log`, and the container creation times
  (`docker inspect`).

### Image pull failures are swallowed by `update-images.sh`

- **Symptom.** On 2026-09-27 the lab step of the weekly update failed to pull (`failed commit
  on ref "manifest-sha256:…": … no such file or directory`, a Docker Desktop containerd store
  error). The script went on to `up -d`, which recreated nothing, and reported the lab
  `All stacks updated and verified.`
- **Cause.** The pull runs as `docker compose … pull … | grep … | sed …`
  (`fleet-boot/update-images.sh:163`), and before the fix its exit status was never checked,
  unlike `up -d` on the next lines.
- **Impact.** Low. The stack keeps running on its old images, so nothing breaks; but the lab
  silently stops being a canary for new sidecar images, and a prod or staging pull failure
  would look like "no update available".
- **Status: fixed 2026-09-29** (prod `507cd044`, lab `faacfd18`, staging `50c7e577`). The
  script reads compose's own exit status right after the pipeline (`PIPESTATUS[0]`; the
  pipeline's status would come from `grep`, which exits 1 on empty output). A failed pull prints
  `FAIL pull (docker compose pull exited N) — continuing with the images already present` and
  adds `<stack>:pull` to the failures, so the run ends `FAILED: …` and exits 1
  (`fleet-boot/update-images.sh:153-168`). The stack is still recreated and verified with the
  images it has, and later stacks still run
  ([fleet scripts](/operations/fleet-scripts#update-images-sh)).

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
- **Never enable a Docker-waiting unit at boot on a WSL host** (.17, .160, .171). It deadlocks the
  boot ([WSL host hung at boot](#wsl-host-hung-at-boot)). `ask-fleet-boot` runs there from
  `fleet-boot.timer`, which lives in the separate `lan_automation` repository; if that timer is
  ever disabled, the boot reconcile silently stops running on the WSL hosts. Check with
  `systemctl is-enabled fleet-boot.timer`.
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
