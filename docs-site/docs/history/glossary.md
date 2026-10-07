---
title: Glossary
---

# Glossary

Terms used across this site, the code, the commit messages and the telemetry. Grouped by area;
use your browser's find to jump around. Where a term maps to code, the main file is given.

## Environments and deployment

| Term | Meaning |
|---|---|
| **Lab** | The experiment environment. Worktree `ask-flow`, branch `flow-design`, compose project `ask-stack-lab`, container `ask-lab`, port **3742**. Runs with `ENABLE_AUTH=false` (anonymous user `lab-harness`). Architecture changes are built and measured here first. → [environments](/operations/environments) |
| **Staging** | Worktree `ask`, branch `admin-feature`, project `ask-stack-admin-feature`, container `ask-admin-feature`, port **3739**. Same image recipe as prod; it differs only by env flags in `docker-compose.admin-feature.yaml`. |
| **Prod** | Worktree `ask-prod`, branch `dev`, project `ask-stack`, container `ask`, port **3738**. Public at `ask.hbqnexus.win` through a Cloudflare tunnel. The **base `docker-compose.yaml` is prod**. |
| **Worktree** | The three environments are three `git worktree`s of one repository under `/home/nightfury/selfhosted/`, each pinned to its branch. Each env builds from **its own** worktree. |
| **Overlay** | An extra compose file stacked with `-f` (`.lab.yaml`, `.admin-feature.yaml`, `.vpn*.yaml`). Overlays **merge** `environment:` onto the base, and an overlay's value **beats `.env`**. |
| **Port / cherry-pick** | Moving a lab commit to staging and prod with `git cherry-pick -x`. The `-x` trailer records the lab original. |
| **Back-merge** | Merging `dev` into `flow-design` so lab has prod's changes (last done in `dd7e0ca1`, 2026-08-22). |
| **`rebuild-ask.sh`** | `fleet-boot/rebuild-ask.sh {prod\|staging\|lab}`: build, health check and reclaim in one step, with the right `-p`/`-f` set. The safe way to rebuild. |
| **Reclaim** | `fleet-boot/reclaim-space.sh`: prunes unused build cache and dangling images (never `-a`, never containers or volumes). Runs after every rebuild. |
| **Rollback point** | The prod commit before a deploy, noted in the commit message or audit log. Roll back by resetting `dev` to it and rebuilding. → [deploy](/operations/deploy) |
| **fleet-boot** | The `fleet-boot/` scripts. `ask-fleet-boot.sh` is a host-aware systemd oneshot that waits for Docker, reconciles app stacks onto fresh networks, retries gluetun/SearXNG (`ensure_vpn_search`) and warms models. It is enabled at boot only on bare metal (.231); on the WSL hosts it is disabled and started ~75 s after boot by the `lan_automation` `fleet-boot.timer`, because a Docker-waiting unit at boot deadlocks WSL ([D41](/history/decisions#d41-on-wsl-hosts-nothing-that-waits-for-docker-is-enabled-at-boot)). Also holds the cron wrappers (upload sweep, docker maintenance, Mullvad rotation) and the auto-update timers. |
| **Model Manager** | A standalone Next.js admin app (`selfhosted/model-manager/`, `127.0.0.1:3939`, password-gated). It edits prod's `.env` with backups and recreates `ask` with the exact prod compose command. The sanctioned way to change prod env config. It is effectively root on the host. → [D26](/history/decisions#d26-model-manager-is-the-sanctioned-env-editor) |
| **`shared-infra`** | An external Docker network the app containers join. On .231 it let containers reach shared services by name (flaresolverr, degoog); on .17 the app reaches fleet services by LAN IP instead (FlareSolverr at `192.168.50.231:8191` since 2026-09-23). Prod's `ask` must be on both `ask-stack_default` **and** `shared-infra`. |

## Fleet

| Host | Name | Role |
|---|---|---|
| **192.168.50.17** | **NightFuryX** | The **app host** since 2026-08-23. WSL2 with Docker Desktop, Threadripper 3970X, 3 GPUs. Runs all three app stacks, per-env SearXNG, gluetun, Postgres and Redis. The RTX 2080 Ti runs Whisper STT `:8788`, the reranker `:8787` and the ingestor. The Quadro P2200 runs Kokoro TTS `:8890`. The GTX 1070 runs `qwen3-vl:4b` for ingest-time image reading. Also runs the native Ollama cloud proxy `:11434`, Model Manager and the cloudflared Windows service for `ask.hbqnexus.win`. |
| **192.168.50.160** | **NightFuryS** | GPU **embedder** (`Qwen3-Embedding-0.6B`, `:8788`, Quadro P4000). WSL2. |
| **192.168.50.171** | **Serenity** | `LOCAL_LLM_BASE_URL`: native Ollama serving `granite4.2:8b` on a Quadro P5000 for titles, memory extraction, the expander fallback and the voice gist. WSL2. |
| **192.168.50.231** | **MiniNightFury** | Native Linux, no GPU. The former app host. Now runs **crawl4ai** `:11235`, the **public SearXNG** (`search.hbqnexus.win`), the **public degoog `:4444`**, flaresolverr and the cloudflared for the other public routes. |
| 192.168.50.206 | Pi | AdGuard DNS for the LAN. It once served a stale negative cache for `ask.*` after the migration. |

→ [fleet](/infrastructure/fleet), [services](/infrastructure/services)

## Services

| Term | Meaning |
|---|---|
| **SearXNG** | The meta-search engine. Each env has its own (`ask-searxng`, `ask-searxng-admin-feature`, `ask-searxng-lab`), running inside its gluetun's network namespace. In the current tiering it is only used by **quality** mode. |
| **Public SearXNG** | `search.hbqnexus.win` on `.231`: the owner's personal instance. Ask never uses it as a primary; prod and staging use it only as their SearXNG fallback (`SEARXNG_FALLBACK_API_URL`, since 2026-09-23, audit H2). Always say "public SearXNG" for it and "prod/staging/lab SearXNG" for the others. |
| **gluetun** | A VPN sidecar container (Mullvad WireGuard). Only SearXNG (and degoog) run in its network namespace, so only search egress goes through the VPN; the app's own egress does not. It has a kill switch. Exits are rotated daily (`rotate-mullvad.sh`). Can lose a cold-boot race for `/dev/net/tun`. |
| **degoog** | A search scraper/aggregator. There are four stacks: **public `:4444` on `.231`** (people use it; never decommission it) and per-env prod `:4445`, staging `:4446` and lab `:4447` on `.17`, all **disabled** (`DEGOOG_ENABLED=false`). → [D30](/history/decisions#d30-degoog-public-instance-kept-per-env-scrapers-disabled) |
| **crawl4ai** | A headless-Chromium page renderer (`unclecode/crawl4ai`, pinned) at `.231:11235`, token-gated. The primary crawler for advanced search and `fetch`. Its memory guard is blind to its cgroup limit, so a cron watchdog restarts it. |
| **Legacy crawl** | The in-process fallback crawler (`crawlPage`, Readability + JSDOM). Capped, because it blocks the Node event loop. |
| **flaresolverr** | A Cloudflare-challenge solver in the `fetch` rescue chain, on `.231:8191` (`FLARESOLVERR_URL`, reachable from every env since 2026-09-23). |
| **Reranker** | The cross-encoder service (`.17:8787` `/rerank`, `RERANKER_URL` + `RERANKER_API_TOKEN`). Scores query–passage pairs; truncates at `max_length=128`. Falls back to the bi-encoder, then to keywords. |
| **Embedder** | The GPU embedding service (`.160:8788` `/embed`, `EMBEDDING_SERVICE_URL`). Model `Qwen3-Embedding-0.6B`, 1024-d, **data-locked** to the pgvector columns. → [D24](/history/decisions#d24-the-embedding-model-is-data-locked) |
| **Bi-encoder** | Local embedding similarity (MiniLM for rerank, `Xenova/all-MiniLM-L6-v2`). Used for speed-mode passage selection and as the rerank fallback. |
| **Ingestor** | The external upload-processing worker (a separate top-level `selfhosted/ingestor/`, its own git repo, not in this repo). It pulls jobs from `/api/ingest/claim`, extracts text from images/office/media (images via `qwen3-vl:4b`), and returns chunk strings for the app to embed. There is **one per env** (`ingestor`, `ingestor-staging`, `ingestor-lab`), each pointed at one `ASK_URL`. |
| **Ingest heartbeat** | Redis key `ingest:heartbeat`, refreshed whenever the worker calls claim or progress (TTL 60 s). A stale heartbeat plus an unclaimed job means "processing is down". |
| **Kokoro / TTS** | The text-to-speech service (`ask-tts`, `.17:8890`) behind `/api/voice/speak`, for read-aloud. |
| **Whisper / STT** | Speech-to-text (`ask-whisper`, speaches, `.17:8788`, `faster-distil-whisper-large-v3`) behind `/api/voice/transcribe`, for dictation. Must stay resident (`WHISPER__TTL=-1`). |
| **Ollama (cloud proxy)** | A native Ollama daemon on each host. `…:cloud` model ids are forwarded to Ollama Cloud (ollama.com). "Cloud model" in Ask always means an Ollama cloud model. |
| **Extra-usage / 402** | Some Ollama Cloud models bill "extra usage" and return HTTP 402 when that balance is empty. `/api/show` resolving does not prove a model works; only a real generation does. |
| **granite** | `granite4.2:8b`, the small local model on Serenity (the `LOCAL_LLM`). |
| **cloudflared** | Cloudflare tunnel connectors. `ask.hbqnexus.win` is served by one running as a Windows service on `.17`. No ports are forwarded. |

## A chat turn

| Term | Meaning |
|---|---|
| **Turn** | One user message and the assistant's streamed answer. Orchestrated in `lib/streaming/create-chat-stream-response.ts`. → [chat turn](/request-lifecycle/chat-turn) |
| **Classifier** | `lib/agents/query-classifier.ts`, a cloud LLM call before search (`CLASSIFIER_MODEL_ID`, currently `deepseek-v4-pro:cloud`). It returns `skipSearch`, `needsSources`, `needsRecent`, `intent`, a standalone rewrite and `expandedQueries`. Bypassed for speed mode, URL turns and regenerate. Its prompt depends on `ALWAYS_SEARCH` (`getClassifierSystemPrompt`). |
| **`ALWAYS_SEARCH`** | Env flag, **default on** (unset or any value but the literal `off`), read per call: every question gets a web search. `ALWAYS_SEARCH=off` + a container recreate restores the legacy classifier prompt and the `stable-knowledge` gate without a rebuild. The Model Manager's Search tab has an "Always search" switch (`on`/`off`). → [D37](/history/decisions#d37-always-search-every-question) |
| **`skipSearch`** | Classifier flag: the message is **not a question**, so no search. Since 2026-09-26 only greetings/thanks/chit-chat/venting, pure transforms of text already present (rewrite, translate, summarise, reformat; not a request for a recommendation or verdict), pure arithmetic or unit conversion, image requests, and explicit remember/forget instructions that ask nothing else. Leads to the `direct` turn mode. With `ALWAYS_SEARCH=off` it means the older "the conversation already answers this". |
| **`needsSources`** | Classifier flag: the answer turns on citable specifics (version, price, date, statistic, named entity) or on advice where a mistake could harm. **Logged only** since 2026-09-26; it gates the `stable-knowledge` mode only with `ALWAYS_SEARCH=off`. Defaults to TRUE on any failure. → [D3](/history/decisions#d3-needssources-skip-retrieval-for-stable-knowledge) (reversed) |
| **`needsRecent`** | Classifier flag: the answer decays with time. Searches get `time_range=month`. |
| **Expansion / expanded queries** | Extra search variants for the first search. **Fused** into the classifier call. `query-expander.ts` on granite is only the fallback. |
| **Turn mode** | `resolveTurnMode()` in `lib/agents/researcher.ts`: **`direct`** (`skipSearch`; a non-question, answered from the conversation), **`research`** (the search loop; every question since 2026-09-26) or, only with `ALWAYS_SEARCH=off`, **`stable-knowledge`** (no sources or recency needed; `search` unadvertised but still callable). Logged as `turn_mode` on the `[latency]` line. |
| **Forced search / forced first search** | Step 0 of a `research` turn with `ALWAYS_SEARCH` on: `prepareStep` swaps in a synthetic model (`createForcedSearchModel`, `lib/agents/always-search.ts`) that emits one `search` call on the classifier's `standaloneQuery` (URLs removed, ≤400 characters). The real `search` tool runs it; the user's model answers from step 1. Used because the Ollama provider ignores `toolChoice`. Not forced when the user supplied the source (a URL, an attachment with no text, or an attachment the text only points at, such as "what is this"; `detectUserSuppliedSource`) or nothing searchable is left. Logged as `forced_search`, with the reason for a skip in `forced_skip`. → [D37](/history/decisions#d37-always-search-every-question) |
| **Researcher** | The answering agent: an AI SDK `ToolLoopAgent` built by `createResearcher`. It loops tool calls until it answers in plain text or hits `maxSteps` (speed 20 / balanced 50 / quality 100). |
| **Answering model** | The user-selected chat model. Not an optimisation target. → [D1](/history/decisions#d1-optimise-the-pipeline-not-the-answering-model) |
| **`activeTools`** | The tools *advertised* to the model for a step. It is **not enforcement**: the SDK executes any tool present in the `tools` map. To block a tool, remove it from the map. |
| **Answer deadline** | `applyAnswerDeadline` in `prepareStep`: strips tools and forces an answer before the 300 s generation timeout. The same answer-only step (`answerNowOverrides`) is what the search cap applies to a model that keeps going after the cap ([D45](/history/decisions#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps)). |
| **Recall** | Semantic search over the user's **own past chats** (`conversation_chunks`, pgvector). Injected speculatively at the start of a turn (timeboxed by `RECALL_BUDGET_MS`), and available as the `recall` tool. |
| **Memory / `remember`** | Long-term user facts (`user_memories`, pgvector) written by the `remember` tool and by background extraction. |
| **Candidate memory** | A memory row with `status='candidate'`. It accumulates `sightings` before graduating to `confirmed`. On retrieval turns, `remember` writes candidate-only, which closes a one-shot memory-poisoning path. |
| **Narration** | "Process talk" the model writes as visible text instead of reasoning, in any language: a status note before a tool call ("Let me search…", "Tôi cần đọc trang này…"), or a preamble in front of the answer's `## ` heading ("The search limit has been reached…"), sometimes glued to it (`…câu trả lời.## `). Recognised by English phrases and, since 2026-09-28, by its shape. The live stream strips what it can, the saved message is cleaned at persist time, and every reader (chat view, copy, model history, recall, search snippets) applies the same cleanup (`narrationCleanView`), so old answers display clean too. Stored staging and prod history was cleaned by the **narration backfill** (`scripts/backfill-narration.ts`, 2026-09-28/29). → [Models & reasoning](/search/models-reasoning#narration-and-chain-of-thought-leak-handling), [D20](/history/decisions#d20-narration-strippers-strict-at-persist-best-effort-live) |
| **Reasoning / think** | The model's chain of thought. Controlled by `ANSWER_THINK` (default off; `targeted` exists on lab only). Displayed as a compact pill unless `NEXT_PUBLIC_SHOW_REASONING=true`. |
| **Title generation** | A new chat's title comes from granite (8 s timeout, falls back to the opening words) and streams as `data-title`. |
| **Spoken gist** | A short spoken summary for read-aloud (voice). |

## Search

| Term | Meaning |
|---|---|
| **Search mode** | The UI's **Speed / Balanced / Quality** (the `searchMode` cookie, default balanced). There is no `deep-research` mode; **quality is the deep-research protocol**. → [search pipeline](/search/pipeline) |
| **Source tier** | Which providers a mode fans out to. Speed: Ollama web only, no crawl. Balanced: Ollama web + Tavily + Brave + LangSearch. Quality: balanced + SearXNG + degoog, plus crawl. |
| **Fan-out** | The parallel provider calls in `/api/advanced-search` (`Promise.allSettled`). Fails open per provider; since 2026-09-23 that includes SearXNG (before, a SearXNG failure in quality mode threw and emptied the search). |
| **Advanced-search fallback** | Since 2026-09-27: when the search tool's call to `/api/advanced-search` gets no response headers within 20 s, or does not finish within 180 s, it runs a basic SearXNG search instead and logs `kind:"advanced-fallback"`. → [pipeline](/search/pipeline#advanced-search-deadline-and-fallback) |
| **Depth: advanced / basic** | The first search of a balanced or quality turn is `advanced` (full fan-out, crawl, rerank, via `/api/advanced-search`). Later searches are `basic` (lighter). |
| **Advanced slot** | Only one advanced search per turn. After it, follow-ups are basic, and the model reads specific pages with `fetch`. |
| **Round cap** | `SEARCH_ROUNDS_MAX` (3) / `SEARCH_ROUNDS_MAX_QUALITY` (10 since 2026-09-30, before that 5): the maximum number of `search` calls per turn that actually run (a near-duplicate skip does not count), enforced inside the tool. Past it, the tool returns an "answer from what you have" result; in quality it still allows fetching URLs found this turn. Logged as `kind:'round-cap'` with `fetch_allowed`. Parallel calls in one step can overshoot it ([known issue](/history/known-issues#parallel-search-calls-can-overshoot-the-round-cap)). From the step after the first refusal `search` is no longer offered, and a model that calls it anyway, or in speed/balanced uses tools on `POST_CAP_TOOL_STEPS_MAX` (4) more steps, gets answer-only steps (since 2026-10-07; lab, staging and prod). → [D9](/history/decisions#d9-search-round-cap-enforced-inside-the-tool), [D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap), [D45](/history/decisions#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps) |
| **Fetch cap** | `FETCH_ROUNDS_MAX_QUALITY` (8): the maximum number of `fetch` calls in a quality turn (each reads up to 5 URLs), since 2026-09-30. Other modes have none unless `FETCH_ROUNDS_MAX` is set. Past it a `fetch` returns a notice instead of pages and logs `[fetch] fetch cap reached`. (`lib/tools/fetch-budget.ts`) |
| **Near-duplicate skip (search dedup)** | A search that repeats one this turn already ran in the same search mode returns a "Skipped: near-duplicate" note instead of results, with no fan-out and no round used (`[search-dedup] skipping … (exact)` / `(near, cos=…)`). Since 2026-10-01 a repeat is either **exact** (equal once case, punctuation and quotes are ignored; needs no embedding) or **near**: cosine ≥ `SEARCH_DEDUP_THRESHOLD` (0.90) **and** the later query adds no content word, drops no number other than a year, and does not reverse the word order around to/from/than (`lib/tools/search/query-dedup.ts`). Before that, cosine ≥ 0.92 alone decided, and it skipped templated queries about different things (`SEARCH_DEDUP_TOKEN_GUARD=off` restores it). → [pipeline](/search/pipeline#round-cap), [D42](/history/decisions#d42-near-duplicate-search-skip-only-for-true-repeats) |
| **Citation reminder** | An experiment (`CITATION_REMINDER=on`, off everywhere): on a turn with 8+ search/fetch calls, the step that starts writing the answer is aborted and re-run once with the citation rules as a trailing user message. Built and measured, not adopted. → [D40](/history/decisions#d40-quality-mode-read-pages-past-the-search-cap) |
| **Prefetched URLs** | Results whose provider already returned page content (Ollama web, Tavily, LangSearch, Brave beyond `BRAVE_CRAWL_MAX`), so crawling is skipped. |
| **Crop / enrich** | Each crawled page's text is cut to `SEARCH_ENRICH_MAX_CHARS` (20k) before reranking. |
| **Crop-position shadow** | Measurement-only logging (`[crop-pos]`, `[cite-urls]`) of where the kept content sat in each page. It never changes answers. |
| **Quality filter** | `isQualityContent`: drops thin pages. Strict on prod (>50 words, >3 sentences, sane sentence length); relaxed on staging and lab. The largest single cut in the pipeline. |
| **Snippet gate** | An optional pre-crawl cross-encoder filter on title+snippet (`SEARCH_SNIPPET_GATE`, off everywhere). |
| **Rerank tiers** | Cross-encoder → bi-encoder cosine → keyword, each degrading to the next on failure. Keeps the top passages per source in document order. |
| **Passage budget** | `RERANK_PASSAGE_BUDGET` (160): total passages scored per rerank call. It trims passages per document, never the document list. |
| **Excerpts** | The retired mode (`SEARCH_EXCERPTS_ENABLED`, off) in which the model saw top-3 passages instead of the page. → [D15](/history/decisions#d15-source-excerpts-instead-of-full-pages) |
| **`fetch` rescue chain** | The `fetch` tool's escalation for reading a URL: plain → crawl4ai → flaresolverr → Tavily → Firecrawl, capped at ~40 s. SSRF-guarded (initial URL only). |
| **Citation** | Inline `[N](#toolCallId)` in the answer: result N (1-based position in that call's `results`, restarting at 1 for every call) of a tool call made in the same message. Since 2026-09-27 the model copies it from the result's citation handle instead of counting. Resolved to a source chip by `resolveCitationAnchor` in `lib/utils/citation.ts`; an anchor it cannot resolve renders as nothing. Citable part types: search, fetch, `documentRetrieval`. → [frontend › Citations](/request-lifecycle/frontend#citations) |
| **Citation handle (`cite`)** | The finished citation string, `[N](#<toolCallId>)`, put as the first key on each citable search result, fetched page and attached-document excerpt in the tool output the **model** sees (`lib/utils/citation-handles.ts`). N is exactly what the renderer resolves, and the prompts say to copy it, never compute it. Never stored or shown in the UI. Flag `CITATION_HANDLES`, default on; only `off` disables it. → [D38](/history/decisions#d38-ready-made-citation-handles) |
| **Snippet citation** | A rendered citation whose cited result is a search **snippet** (text of at most 1,000 characters, `SNIPPET_MAX_CHARS`) rather than page text. Since 2026-10-01 the `[latency]` line counts the ones whose page the turn never read (`citations_snippet`) and the ones whose page it did read under a same-page URL (`citations_snippet_read`), via `auditCitationEvidence` in `lib/utils/citation.ts`. Telemetry only: rendering is unchanged. → [frontend](/request-lifecycle/frontend#citation-evidence), [D43](/history/decisions#d43-snippet-citations-measured-not-re-pointed) |
| **`documentRetrieval`** | A synthetic, citable tool part emitted for attached documents and pasted URLs, so they cite like web sources. Each excerpt carries its own citation handle. |

## Streaming and client state

| Term | Meaning |
|---|---|
| **Resumable stream** | The SSE response is mirrored to Redis (`resumable-stream`), with a pointer at `ask:chat:{chatId}:activeStream` (TTL 300 s). A reconnecting client resumes through `GET /api/chat/[chatId]/stream`. A **finished** stream is not replayable: the client gets 204 and reloads the persisted messages. → [streaming](/request-lifecycle/streaming) |
| **Generation / kill controller** | Authed turns run on a server-side abort signal (Stop or the 300 s timeout), **not** the request signal, so closing the tab does not stop generation. Registry: `lib/streaming/active-generations.ts`. |
| **Stop** | The client calls `stop()` **and** `POST /api/chat/[chatId]/stop`. The partial answer is kept, with `metadata.stopped=true`. |
| **pushState chat** | A chat started from the homepage. After the first send, the URL is changed to `/search/<id>` with `history.pushState`, but the Next route is still `/`, and the row only exists after `onFinish`. It **must not be `router.refresh()`ed**. → [D28](/history/decisions#d28-sidebar-refresh-invariants-and-uncached-conversation-reads) |
| **`chat-bump`** | A browser `CustomEvent` that moves a chat to the top of the sidebar's Recent list optimistically (`detail: {chatId, title?, isNew?}`). It never triggers a refresh. |
| **`chat-history-updated` / `current-chat-deleted`** | The only sidebar events that trigger a (debounced, deferred-while-streaming) `router.refresh()`. |
| **Stream activity registry** | `lib/streaming/stream-activity.ts`: tracks whether any chat is streaming so refreshes wait. |
| **`loadChat` / `loadChatUncached`** | `lib/actions/chat.ts`. `loadChat` goes through `unstable_cache` and is **stale-while-revalidate**, so use it for metadata only. Conversation views and history reads must use `loadChatUncached`. |
| **Optimistic Recent** | `components/sidebar/recent-optimistic.ts`: a client-side overlay that max-merges `lastViewedAt` so a stale server refresh cannot undo a fresh bump. |

## Data and security

| Term | Meaning |
|---|---|
| **RLS** | Postgres row-level security. Every table has a policy on `current_setting('app.current_user_id')`, set per transaction by `withRLS(userId, cb)`. It only isolates when the app connects as the restricted role. → [data layer](/infrastructure/data-layer) |
| **`app_user`** | The non-owner Postgres role the app runs as (`DATABASE_RESTRICTED_URL`), so RLS is enforced. A fail-fast guard in `lib/db/index.ts` exits in prod if the role bypasses RLS. |
| **`dbAdmin`** | The owner (RLS-bypassing) Drizzle client, used only for system and cross-user work: ingest endpoints, file actions, maintenance. Any route using it must be token-gated. |
| **Owner role / `DATABASE_URL`** | The superuser connection used by migrations (`bun run migrate` at container boot, fail-hard). |
| **Anonymous mode** | `ENABLE_AUTH=false`: everyone shares one `ANONYMOUS_USER_ID`. Lab only. |
| **`INGEST_API_TOKEN`** | The bearer token for the ingest worker endpoints **and** (currently) `/api/advanced-search`, including its Redis probe. |
| **Local Redis connector** | `createLocalRedisConnector` (`lib/redis/local-redis.ts`), the only way app code gets a local Redis client: it reconnects by itself, rejects commands fast while disconnected and bounds each at 1 s. → [D39](/history/decisions#d39-every-local-redis-client-goes-through-local-redis-ts) |
| **Redis probe** | `GET /api/advanced-search` with the internal bearer: PINGs Redis through the search route's client and fires no search. Run inside the app container by `update-images.sh` after every sidecar update. → [runbook](/operations/runbooks#search-hangs-after-a-redis-restart) |
| **Signed upload URL** | An HMAC-signed, expiring `/uploads/…?exp=…&sig=…` link. Shipped but dormant until `UPLOADS_URL_SECRET` is set. → [D25](/history/decisions#d25-signed-upload-urls-shipped-dormant) |
| **Fast path / worker path** | Upload processing. Text and PDF up to 20 MB are chunked in the app at upload time (fast path). Everything else goes to the external ingestor (worker path). |
| **`.chunks.json`** | The on-disk sidecar holding an upload's chunks and embeddings, next to the file. Upload RAG does not use pgvector. |
| **Upload TTL sweep** | A daily job (`/api/maintenance/expire-uploads`) that deletes files of chats idle for `UPLOAD_TTL_DAYS` (14). Generated images are exempt. |
| **SSRF guard** | `assertUrlAllowed` (`lib/utils/ssrf-guard.ts`): blocks private/LAN targets for `fetch`. Checks the initial URL only (see [known issues](/history/known-issues#redirect-based-ssrf)). |
| **`UNTRUSTED_CONTENT_RULE`** | The prompt clause on every turn that tells the model retrieved content is data, not instructions. |

## Telemetry

| Term | Meaning |
|---|---|
| **`[latency]` line** | One structured log line per turn: model id, stage timings (`classify_ms`, `recall_ms`, `search_ms`, `crawl_ms`, `rerank_ms`, `ttft_ms`, `answer_wait_ms`, `total_ms`…) and flags, including `turn_mode`, `forced_search` and `forced_skip` since 2026-09-26. On a forced-search turn `ttft_ms` is only the pre-work; time to first prose is `stream["text-start"]`. → [telemetry](/operations/telemetry) |
| **`latency:log`** | The Redis list holding recent `[latency]` entries. `LPUSH`, so **newest at the head**. It persists across deploys, so filter by fields only new code emits when checking a change. |
| **`[latency:search]` / `[latency:classify]`** | Per-stage detail lines (for example `kind:'round-cap'`, `outcome:'budget'`). |
| **A/B (lab)** | One build, arms switched by env flags (`docker compose … up -d --force-recreate ask`), interleaved turns, judged answers. → [testing](/operations/testing-qa) |

## Product and UI names

| Term | Meaning |
|---|---|
| **Orbit** | The cosmic homepage design (Aug 2026): a three-body canvas field, cycling "Ask ___." headline, glass composer. |
| **Wild Breath** | The three-body brand mark and animated research indicator (`lib/wild-breath/sim.ts`). |
| **Discover** | The news briefing and feed (`/discover`, `/api/discover`), fed by SearXNG news through the failover breaker. |
| **Library** | `/library`: the full chat manager with keyword (`pg_trgm`) and semantic search. |
| **Recent** | The date-grouped chat list in the collapsible sidebar. |
| **morphic** | The upstream open-source project Ask was forked from (June 2026). Some upstream docs (`CLAUDE.md`, README fragments) are stale. |
| **Vane / Onyx** | Other answer engines used as design references. Ideas were adopted only when an A/B proved them better (the "best of both" rule). |
