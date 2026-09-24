---
title: Changelog
---

# Changelog

A condensed timeline of significant changes, newest first. Commit hashes are the **prod (`dev`)**
commits unless marked *lab*. Staging (`admin-feature`) carries the same change as a
cherry-pick. Every entry below was shipped to prod unless it says otherwise. For the reasoning
behind a change, follow the **D-number** to [decisions](/history/decisions). For what is still
open, see [known issues](/history/known-issues).

::: tip How to get the full detail
`git log dev --since=<date> --until=<date>`. Most commits carry a long body with the measurement
behind the change. Lab-first work lives on `flow-design`. `git cherry-pick -x` leaves a
`(cherry picked from commit …)` trailer that points back to the lab original.
:::

## 2026-09 — September

**Streaming lifecycle, mobile QA, the end of the latency campaign, and a fleet clean-up**

- **09-24** — **Bug-fix batch** (built on the lab, then ported to staging and prod):
  - **"Stopped" label.** A stopped answer shows a muted "Stopped" pill in its action row, live
    (`markMessageStopped`, set by the client when the Stop lands) and after a reload (the
    persisted `metadata.stopped`). The action row wraps on narrow phones.
    → [streaming](/request-lifecycle/streaming#stop)
  - **Unresolved citations**, three pipeline causes: fetch results now carry their
    `toolCallId`; earlier answers' anchors are stripped from the model-bound history
    (`strip-citation-anchors-from-history.ts`); a strict single-match URL-fragment resolver
    (`resolveByUrlFragment`) renders anchors that name a page's URL instead of an id. New
    `citations_recovered` field on `[latency]`. Replay on prod history: unresolved 16.6 % → 14.5 %
    (last 45 days 7.1 % → 5.2 %) from the resolver alone.
    → [D36](/history/decisions#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)
  - **Memory consolidation scheduled**: `fleet-boot/memory-consolidate-nightly.sh`, .17 cron
    03:45, each env's secret read from its own `.env` and sent on stdin.
    → [memory & recall](/knowledge/memory-recall#how-to-schedule-memory-consolidation)
  - **Auth middleware page gate works**: `/` is matched exactly and public prefixes match whole
    segments, so signed-out visitors to unknown or new paths go to `/auth/login` (never with
    `ENABLE_AUTH=false`). Dead `hooks/use-auth-check.tsx` and `components/auth-modal.tsx`
    deleted. → [auth & accounts](/request-lifecycle/auth-and-accounts#the-page-gate-fixed-2026-09-24)
  - **Model Manager**: random per-login sessions with a server-side 24 h expiry and revoking
    logout; `/api/restore` accepts only listed app-made backups and snapshots `.env` first;
    hand-made `.env.bak.*` files are ignored; a **Clear this secret** action.
    → [Model Manager](/infrastructure/model-manager#authentication)
  - **Ingestor** (`ba5fc5c`): 401/403 and 503 on claim are logged once as config errors and
    re-checked every 300 s instead of crash-looping or retrying silently; a per-job heartbeat
    (`HEARTBEAT_INTERVAL`, 180 s) stops long jobs being re-claimed as stale; `.env.example` is
    tracked. → [ingestor](/knowledge/ingestor#main-loop-and-claim-back-off)
  - **Fleet scripts**: `update-ask.sh` and its timer units are on `flow-design` too;
    `update-images.sh` gained an `ask-lab` entry, and the weekly run goes lab (canary) → prod →
    staging. → [fleet scripts](/operations/fleet-scripts#update-ask-sh-fleet-update-ask-service-timer)
  - **Eval scripts** target the lab on .17 (`ASK_LAB_DIR`, `ASK_LAB_URL`) and refuse to recreate
    `ask-lab` from another worktree; `judge-flow-arms.py` uses the .17 Ollama; `EVAL_MODEL` is
    honoured everywhere; `bun chat --no-search` removed. → [evaluation](/operations/evaluation)
  - **Hygiene**: `granite4.2:8b` in comments; the lab's copies of `docker-compose.yaml` and
    `docker-compose.admin-feature.yaml` synced to prod and staging (degoog disabled everywhere);
    `engines.node` is `^20.19.0 || 22.x`.
- **09-24** — **.231 fully cleaned.** The retired stacks' kept volumes, their images and the old
  `ask`/`ask-prod`/`ask-flow` checkouts on MiniNightFury were deleted. The 42 commits that
  existed only in .231's lab checkout were kept as local branches `archive/231-flow-design-pipeline`
  and `archive/231-wip-context-latency-budget` (not on `origin`).
  → [D35](/history/decisions#d35-retire-and-remove-the-231-ask-stacks)
- **09-23** — **Documentation-audit fixes**, shipped to lab, staging and prod the same day (prod
  `fae9682a`..`50e03340`, lab `06dfbd2b`..`80c44c6a`):
  - A SearXNG failure no longer empties an advanced search: it counts as an empty SearXNG share,
    the other providers' results are returned, the degraded result is **not cached**, and
    `[latency:search]` carries `searxng=ok|failed` (`fae9682a`).
  - The legacy crawler (`lib/utils/legacy-fetch-html.ts`) runs the SSRF guard on the start URL and
    on **every redirect hop**, max 5 (`4db7325e`). → [security](/infrastructure/security)
  - The 200 s answer deadline is **enforced inside each tool's `execute`**, and its clock starts
    at the start of the turn (`a3100ba6`, `lib/agents/answer-deadline.ts`).
  - The memory consolidator lists users through `dbAdmin`, so RLS no longer hides them
    (`995f23f3`). Scheduling it followed on 09-24.
  - Follow-ups in home-started chats bump the chat and call `touchChat` (`5070af4c`).
  - Fast-path uploads start as `processing`, so the ingestor cannot ingest them twice;
    `UPLOAD_TTL_DAYS` has one parser, `lib/config/upload-ttl.ts` (`6a6c68af`).
  - **Recall latency:** candidates (embed + DB) are prefetched during classification and the
    rerank runs once on the final query; `RECALL_RERANK_POOL` 20 → 10, new
    `RECALL_RERANK_MAX_LENGTH` 384. Recall p50 about 1.3 s, inside the 1.5 s budget (`d0585bf8`).
    → [D34](/history/decisions#d34-recall-rerank-deferred-not-aborted)
  - Model Manager: `EMBEDDING_MODEL` is read-only; `RECALL_RERANK_MAX_LENGTH` is editable
    (`32e0b1d0`).
  - Test suite fully green (`1ff09c73`). → [testing](/operations/testing-qa)
- **09-23** — **Infra fixes:**
  - Serenity (.171) Ollama bound to `0.0.0.0` again via the drop-in
    `/etc/systemd/system/ollama.service.d/host.conf`; `granite4.2:8b` re-pinned. The LAN exposure
    was accepted by the owner.
  - Compose: the staging `CRAWL4AI_URL` pin was removed, and the staging and lab classifiers point
    at `.17` like prod (`20f59696`).
  - FlareSolverr is published on `192.168.50.231:8191` and `FLARESOLVERR_URL` points there in
    every env. Prod and staging set `SEARXNG_FALLBACK_API_URL=http://192.168.50.231:8127`; lab
    has no fallback.
  - The retired .231 Ask stacks, which a stale boot script had recreated on 09-16, were removed
    (containers and networks).
  - fleet-boot: `rotate-mullvad.sh` uses each env's own worktree; `rebuild-ask.sh` exits 1 (and
    keeps the old image) when the app never serves 200; boot reconciles all three ingestors;
    `deploy.sh` syncs .231 (`68b97ffe`, `773bd01e`, `bd77dcc5`). .231's rotation and weekly
    public-search update run from `~/fleet-boot` (`3dec61c9`); `update-images.sh` health-checks
    the Ask stacks on localhost (`f1ab1b3c`).
  - The reranker and Whisper are pinned to the 2080 Ti by GPU UUID. The ingestor directory became
    a git repo, and the worker backs off when Ask is unreachable instead of crash-looping (it had
    restarted more than 1,100 times during Ask outages).
  → [known issues](/history/known-issues), [fleet](/infrastructure/fleet)
- **09-22** — **QA sweep fixes** (two rounds):
  - **A new chat's first answer vanishing about 1 s after it finished** (a critical bug introduced
    on 09-21) is fixed. `app/search/[id]/page.tsx` now reads `loadChatUncached`. A home-started
    chat's `onFinish` sends an optimistic `chat-bump` instead of a refresh. A stream-activity
    registry defers sidebar refreshes while anything streams. Stop now reaches home-started
    chats. Edit and Retry refuse while a turn is in flight (`eb8de320`).
    → [D28](/history/decisions#d28-sidebar-refresh-invariants-and-uncached-conversation-reads)
  - **Stop keeps the partial answer** (sanitised, `metadata.stopped`, newer-turn guard). **Resume
    after a disconnect** no longer duplicates parts, and a 204 reloads from the new owner-only
    `GET /api/chat/[chatId]/messages` (`554a4921`).
    → [D29](/history/decisions#d29-stop-keeps-the-partial-answer), [streaming](/request-lifecycle/streaming)
  - Sidebar times render in the viewer's timezone; compact one-line weather on mobile
    (`688846c4`).
  - Mobile: composer toolbar overlap fixed, popover bounds, Discover/Library layout (`ed6f4b35`).
    Settings dialog height uses `dvh`, touch-visible delete buttons, tap-to-preview citations, and
    provider `<strong>` markup stripped from snippets (`2b321bf6`).
    → [frontend](/request-lifecycle/frontend)
- **09-21** — Sidebar never runs `router.refresh()` mid-stream: `chat-bump` was removed from
  `REFRESH_EVENTS`. This fixed the UI blanking during an answer (`eb461c8d`).
- **09-20** — Mobile: the composer anchors near the top while focused, so the typed line stays
  visible above the keyboard (`41f8ed8e`).
- **09-19** — The 404 flash on a new chat's first prompt is fixed (`fb63e618`). **Follow-up
  re-search prompt nudge** shipped (`03e70c52`; [D19](/history/decisions#d19-follow-up-re-search-prompt-nudge)).
  **Targeted reasoning** was built and A/B'd but not shipped (lab `68e3490d`;
  [D18](/history/decisions#d18-targeted-reasoning-reasoning-only-on-research-turns)). A security ops
  runbook was written (outside the repo).
- **09-17** — Round-cap reasoning dumps and stray `</think>` tags are stripped from answer text
  (`0290896c`; [D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live)).
  The weather widget stops re-prompting for location on every load (Permissions API gate +
  6 h coordinate cache, `e6dccd46`).
- **09-15** — Security defence in depth from the 09-14 review (`bfedea10`): href scheme sanitising
  (`lib/utils/safe-url.ts`), fail-closed chat ownership, a mathjs expression bound, and `nosniff`
  on ingest file downloads. Model Manager re-verifies the session inside `/api/apply` (`ac437a2b`).
  The world-readable `.env` files were `chmod 600`'d. → [security](/infrastructure/security)
- **09-14** — Full A-to-Z security review: **strong**, with no critical or high finding on the
  public surface. The remaining items are operational; see
  [known issues](/history/known-issues#security-awaiting-ops-action).
- **09-12** — **Doc-RAG token budget**: injected document/URL sources are trimmed to the real
  remaining context window, so they can no longer overflow and cause a 400 (`538dd138`).
  **Signed, expiring upload URLs** shipped dormant (`44e4599f`;
  [D25](/history/decisions#d25-signed-upload-urls-shipped-dormant)). A mobile homepage series:
  the real overflow fix in `chat.tsx` (`303d7a0d`), centred hero restored (`8d33b149`), voice
  controls moved behind a `⋯` menu (`2f61714f`), toolbar bounds (`c10922b8`).
- **09-11** — Model roster reconciled across all three envs; `deepseek-v4.1-flash:cloud` added and
  `deepseek-v4-flash:cloud` removed (env only). Prompt caching investigated and rejected
  ([D13](/history/decisions#d13-prompt-caching-on-ollama-cloud)). The **ingestor heartbeat**
  shipped: a user-visible "processing is down" signal (`2f18355c`).
- **09-10** — **Single-pass search** A/B'd on lab and **reverted**
  ([D12](/history/decisions#d12-single-pass-search-instead-of-the-agentic-loop)). Inter-step
  narration is stripped from persisted answers (`378e81af`). The sidebar "Recent" list reorders
  optimistically (`7516dce7`). RAG hardening: bounded ingest wait (default 30 s, 8 s
  unclaimed early-bail), a `RAG_MIN_SCORE` relevance floor, and a fixed stale embedder comment
  (`8795e1b9`). A read-only RAG/upload review corrected the storage picture: upload chunks are on
  disk, not in pgvector ([D23](/history/decisions#d23-uploads-and-url-rag-on-disk-not-pgvector)).
- **09-09** — **Answering-model reasoning OFF by default** (`06bd780b`;
  [D10](/history/decisions#d10-answering-model-reasoning-off-by-default)). **Raw reasoning hidden**
  behind a "Thinking…" pill (`537fa8e6`; [D11](/history/decisions#d11-hide-raw-reasoning-in-the-ui)).
  Time hints added to the search-mode descriptions (`60082f39`).
- **09-08** — Observability: `recall_wait_ms` / `recall_budget_hit`; `recall_ms` now records the
  true background cost (`79fecb19`). → [telemetry](/operations/telemetry)
- **09-07** — The rest of the latency campaign:
  - **Brave crawl cap** `BRAVE_CRAWL_MAX=3` (`2f25aa21`; [D7](/history/decisions#d7-cap-the-brave-crawl-to-the-top-3)).
  - **Timeboxes** for recall (1.5 s), the classifier (4 s soft) and LangSearch (2.5 s)
    (`442b5dcd`; [D8](/history/decisions#d8-timebox-recall-classifier-and-langsearch)).
  - **Search round cap**, 3 balanced / 5 quality, enforced in the tool (`53f03c4f`;
    [D9](/history/decisions#d9-search-round-cap-enforced-inside-the-tool)).
  - Per-env degoog moved from `.231` to `.17` and **disabled** (`0347cdb2`, `ae81f4a9`;
    [D30](/history/decisions#d30-degoog-public-instance-kept-per-env-scrapers-disabled)).
- **09-02 → 09-04** — **Search pipeline rework**: fast mode is Ollama-web only with no crawl
  (`8162458d`); speed mode skips the classifier and recall (`8f4ca45a`); **source tiering by mode**
  (`4002980f`); Brave is crawled rather than prefetched (`4617678e`); **classifier moved to
  `deepseek-v4-pro:cloud`** (config).
  → [D5](/history/decisions#d5-source-tiering-by-search-mode), [D6](/history/decisions#d6-classifier-on-a-cloud-model-with-expansion-fused-in), [search pipeline](/search/pipeline)
- **09-01** — The `images` SearXNG category is limited to advanced depth (`2f65f758`, search_ms
  ~28 s → 8–16 s). `RERANK_PASSAGE_BUDGET` 320 → 160 (env). The `calculate` tool renders inside
  the research accordion (`ca0a3687`, `b7758e4b`).

## 2026-08 — August

**Host migration to NightFuryX, boot resilience, features (voice, docs & URLs, history, homepage)**

- **08-30** — All tool stage timings folded into the single per-turn `[latency]` line (`176c734f`).
- **08-29** — Weekly fleet-wide Ollama auto-update (`1288820a`). → [fleet](/infrastructure/fleet)
- **08-28** — Model refresh: `glm-5.2` → `glm-5.3-flash` (list and, at the time, the classifier);
  local jobs moved to `granite4.2:8b` (`6f2c1f56`, `325ab31f`). The embedder was deliberately left
  pinned ([D24](/history/decisions#d24-the-embedding-model-is-data-locked)). The old `.231` Ask
  stacks were retired; their DB and upload volumes were archived to `.17:/home/nightfury/backups/ask-231-retire-2026-08-28/`.
- **08-27** — The fleet went on a **UPS**. The `.17` crontab was restored: daily upload-TTL sweep
  (`d0cca9e1`), docker/disk maintenance with a Postgres `amcheck` index check (`5d26e224`), and the
  daily Mullvad rotation.
- **08-26** — **Wait for ingest** before the first reply (`bc3f5875`). One ingestor per env
  (`ingestor`, `ingestor-staging`, `ingestor-lab`). fleet-boot retries gluetun and SearXNG after a
  power loss (`476627a4`). → [RAG & uploads](/knowledge/rag-uploads), [runbooks](/operations/runbooks)
- **08-25** — Image uploads stuck in the queue: `ingest/complete` now uses the RLS-bypassing
  `dbAdmin` for its lookup (`b307ebf9`), which the move to the `app_user` role had exposed.
  `rebuild-ask.sh` wrapper (build + health + reclaim, `43318e87`). Read-aloud overhaul:
  single-flight TTS, configurable speed and voice, Listen moved into the answer row, progressive
  (streamed) playback (`09597d32` … `d1f67e60`). → [media](/knowledge/media)
- **08-24** — Boot resilience on the WSL2/Docker Desktop hosts: `wait_docker()` and app-stack
  reconcile on NightFuryX (`6d4ac836`). Proven through three later power losses.
- **08-23** — **Ask moved from MiniNightFury (.231) to NightFuryX (.17)**. The public
  `ask.hbqnexus.win` is now served by a new cloudflared tunnel running as a Windows service on
  `.17`. TTS moved to `.17` on the Quadro P2200 (`fd85c847`). A weekly auto-update timer covers the
  app stacks (`b23e22f2`). Model Manager moved to `.17`.
  → [environments](/operations/environments), [fleet](/infrastructure/fleet)
- **08-22** — Lab reconciled onto prod by merging `dev` → `flow-design` (lab `dd7e0ca1`). The
  **hands-free voice loop** was built on lab and then removed (lab `b0ff56ad`;
  [D31](/history/decisions#d31-hands-free-voice-conversation-loop)). crawl4ai 0.9.1 → 0.9.2 plus a
  weekly version check (notify only). Weekly auto-update for the public search stacks.
- **08-20** — **Cosmic "Orbit" homepage redesign** (`8e0c1873`). bun pinned to 1.3.14
  (`d67e8ddb`). Geolocation restored: `Permissions-Policy` set to `geolocation=(self)`, plus the
  visitor-IP fallback (`40eb0e86`).
  → [D32](/history/decisions#d32-homepage-and-mobile-layout)
- **08-16 → 08-18** — **History & Library overhaul (Slice 1)**: a collapsible, date-grouped
  "Recent" sidebar, a real chat count, and `pg_trgm` trigram search (migration `0021`; 15 ms seq
  scan → 1.7 ms index scan) (`5831b3b7` … `cb880192`). The prod app-host boot self-heal was
  added (`5bb0ff7e`). → [client state](/request-lifecycle/client-state), [data layer](/infrastructure/data-layer)
- **08-16** — **Chat with docs & URLs (Slice 1)**: attached documents and pasted URLs are grounded
  **and citable** through a synthetic `tool-documentRetrieval` part (`a97373ca` … `a985276a`).
  → [RAG & uploads](/knowledge/rag-uploads)
- **08-12 → 08-18** — **Voice mode**: read-aloud through Kokoro TTS and dictation through Whisper
  on the 2080 Ti. Dictation is click-to-record plus press-and-hold (`0b008dfa`), and the transcript
  goes into the composer for review. Microphone allowed in `Permissions-Policy` (`9437d212`).
  Whisper kept resident (`WHISPER__TTL=-1`). → [media](/knowledge/media)
- **08-09 → 08-11** — **Exhaustive architecture audit** (59 findings). Fixes: fail-fast RLS guard
  (`38808865`), post-auth open redirect (`ea29d10a`), prompt-injection boundary plus candidate-only
  `remember` on retrieval turns (`c9489a83`), Discover through the SearXNG breaker (`dc5a4c69`),
  `/api/health` plus a Docker HEALTHCHECK (`612e0bb1`), a legacy-crawl cap on crawl4ai outage
  (`b8818e71`). Model Manager applies the real prod compose command (`f45b96cc`, `49ffb638`) and
  binds to loopback (`9b01367b`).
  → [D26](/history/decisions#d26-model-manager-is-the-sanctioned-env-editor), [security](/infrastructure/security)
- **08-06** — 20k per-page crop plus the crop-position shadow on prod and staging (`0e817799`;
  [D17](/history/decisions#d17-20k-per-page-crop-with-a-crop-position-shadow)).
- **08-05** — **Resumable streams**: authed turns survive a client disconnect and can be resumed
  live (`2bb06966`, `d1a54bfe`). Image-edit fixes, with the edit model pinned to `nano-banana-2`.
  **Two-stage full-content rerank** measured and **shelved**
  ([D16](/history/decisions#d16-two-stage-full-content-rerank)).
  → [streaming](/request-lifecycle/streaming)
- **08-04** — Mobile pass (compact composer, drawer behaviour, home widgets on phones). Lab:
  **multi-agent deep research** A/B'd and shelved ([D22](/history/decisions#d22-multi-agent-deep-research)).
  crawl4ai parallelism benchmark (don't raise it).
- **08-02 → 08-03** — Lab security and correctness sweep, later ported: the **app runs as the
  non-superuser `app_user` so RLS is enforced**, the SSRF hole is closed, advanced search is
  authenticated, security headers added, the image-exfiltration channel is closed at render time,
  and owner-scoping of message/title/feedback writes. Fetched pages are made citable so the model
  can no longer invent anchors (`6a75d3b5`).
- **08-01** — **Source excerpts retired**, because the A/B measured them down (`6366a90b`;
  [D15](/history/decisions#d15-source-excerpts-instead-of-full-pages)). Separate worktrees per env
  ([D2](/history/decisions#d2-lab-first-and-env-flag-isolation-no-per-env-builds)).

## 2026-07 — July

**Ask becomes its own product: retrieval quality, latency instrumentation, uploads, memory**

- **07-30** — **`needsSources`**: stop searching for stable-knowledge questions (`74062395`;
  [D3](/history/decisions#d3-needssources-skip-retrieval-for-stable-knowledge)). Chat titles are
  written by the local model, not the chat model (`2f48d181`).
- **07-28 → 07-29** — The search loop no longer thrashes on its own deduplicated results
  (`ffcc19ec`). The research loop no longer runs out the clock and returns nothing (`a233355a`). A
  turn retrieval budget was tried and **reverted** (`f0d146a6`;
  [D21](/history/decisions#d21-other-latency-knobs-measured)). Prod held at the strict quality
  filter (`fece1f4d`). The lab became an isolated third instance (`fd07b088`).
- **07-26 → 07-27** — SearXNG egress goes through **Mullvad via gluetun**, per env, with a daily
  exit rotation (`aa175418` … `af669048`). SearXNG engine health gate. Pre-crawl snippet gate
  built (left off). **LangSearch** added as a block-immune source (`5b22d4d7`). The `fetch` rescue
  chain is bounded and batched. fleet-boot put under version control (`66ab4c34`).
- **07-24 → 07-25** — **Latency instrumentation**: a per-turn `[latency]` line (`e7fc28f6`),
  persisted to Redis `latency:log` (`348fb346`), plus search-stage timings. Recall gated on
  `skipSearch` and overlapped with the classifier (`a6229633`). Cloud classifier trial reverted
  (`16854f60`). Brave API wired into the fan-out (`064ad944`). Crawl routed through Crawl4AI
  (`269e431f`). Waiting-quotes indicator.
- **07-23** — **Image generation** through Replicate (a 32-model registry, round-robin pools,
  monthly budget, SVG hardening). The saved per-account model pick is remembered (`c1016bdd`;
  [D27](/history/decisions#d27-saved-model-pick-outranks-the-default)). Default model
  `kimi-k2.6:cloud`.
- **07-22** — Tavily and Brave added to the fan-out. The "Wild Breath" three-body brand mark and
  research indicator.
- **07-19 → 07-20** — **Uploads**: streamed uploads up to 2 GB, a token-authed ingest job API with
  an external worker, vision-capability gating, idle-chat TTL expiry (`UPLOAD_TTL_DAYS`). Remote
  GPU embedder and **Qwen3-Embedding-0.6B** (`41951707`, `f3f23550`). Minimal CI (`e072338c`).
- **07-17 → 07-18** — **Ask Model Manager** config UI (`selfhosted/model-manager/`).
- **07-15 → 07-16** — **Long-term memory** (pgvector `user_memories`, `remember` tool) and
  **conversation recall** (`conversation_chunks`, hybrid Library search). Ollama web search merged
  into the advanced path. Conversation history is built from an uncached read (`3e39181d`).
- **07-13 → 07-14** — Pre-search **query classifier** (`73c31abd`). Cross-encoder reranker service
  (`e220cd7c`, `6bd6c66e`). Accuracy workstreams: fetch rescue chain, recency, expansion,
  corroboration (`a53bdefa`).
- **07-06 → 07-08** — Rebrand to **Ask**. `calculate`, weather and academic tools. Native Ollama
  cloud models. A Vane-inspired UI (weather, search modes, Discover). A Vane-style RAG pipeline for
  files (`4cd5d09a`). An isolated compose overlay for staging (`76b04f43`).

## 2026-06 — June

- **06-26** — **Fork point.** Ask's custom work was applied on top of upstream
  [morphic](https://github.com/miurla/morphic) 1.5.0 (`84ddcf1b` "Apply all custom changes from
  morphic-build"). Everything before this commit is upstream morphic history (from 2024-04).
