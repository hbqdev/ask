---
title: Decisions
---

# Decision records

Lightweight ADRs for the choices that shaped Ask. Each record has a **status**:

| Status | Meaning |
|---|---|
| **adopted** | Shipped to prod and still in force |
| **rejected** | Built or proposed, measured, not shipped |
| **reverted** | Shipped (or built on lab), then removed |
| **shelved** | Built, parked on lab behind a flag or in git history; could come back |
| **inconclusive** | Built and measured, but the measurement could not decide it |
| **reversed** | Shipped, then overruled by a later decision; the code stays behind a revert switch |

::: tip Read the negative results first
The **rejected / reverted / shelved** records are the most useful part of this page. Each one
cost days of work. If an idea below looks attractive, read its "Do not retry unless…" line
before building it again.
:::

Commit hashes are on `dev` (prod) unless marked *lab* (`flow-design`) or *staging*
(`admin-feature`). Lab commits are ported with `git cherry-pick -x`, so the prod commit message
names the lab original. See [deploy](/operations/deploy) for the flow.

## Index

| # | Decision | Status | Date |
|---|---|---|---|
| [D1](#d1-optimise-the-pipeline-not-the-answering-model) | Optimise the pipeline, not the answering model | adopted | 2026-09-07 |
| [D2](#d2-lab-first-and-env-flag-isolation-no-per-env-builds) | Lab first; staging/prod differ only by env flags | adopted | 2026-08-01 |
| [D3](#d3-needssources-skip-retrieval-for-stable-knowledge) | `needsSources`: skip retrieval for stable knowledge | **reversed** 2026-09-26 by [D37](#d37-always-search-every-question) (owner) | 2026-07-30 |
| [D4](#d4-judge-answers-not-source-counts) | Judge answers, not source counts | adopted (method) | 2026-08-01 |
| [D5](#d5-source-tiering-by-search-mode) | Source tiering by search mode | adopted | 2026-09-03 |
| [D6](#d6-classifier-on-a-cloud-model-with-expansion-fused-in) | Classifier on a cloud model, with expansion fused in | adopted | 2026-09-04 |
| [D7](#d7-cap-the-brave-crawl-to-the-top-3) | Cap the Brave crawl to the top 3 | adopted | 2026-09-07 |
| [D8](#d8-timebox-recall-classifier-and-langsearch) | Timebox recall, classifier and LangSearch | adopted | 2026-09-07 |
| [D9](#d9-search-round-cap-enforced-inside-the-tool) | Search round cap, enforced inside the tool (quality 10 since 09-30) | adopted | 2026-09-07 / 09-30 |
| [D10](#d10-answering-model-reasoning-off-by-default) | Answering-model reasoning OFF by default | adopted | 2026-09-09 |
| [D11](#d11-hide-raw-reasoning-in-the-ui) | Hide raw reasoning in the UI | adopted | 2026-09-09 |
| [D12](#d12-single-pass-search-instead-of-the-agentic-loop) | Single-pass search instead of the agentic loop | **reverted** | 2026-09-10 |
| [D13](#d13-prompt-caching-on-ollama-cloud) | Prompt caching on Ollama Cloud | **rejected** | 2026-09-11 |
| [D14](#d14-history-trimming) | History trimming | **rejected** (already done) | 2026-09-11 |
| [D15](#d15-source-excerpts-instead-of-full-pages) | Source excerpts instead of full pages | **rejected** | 2026-08-01 |
| [D16](#d16-two-stage-full-content-rerank) | Two-stage full-content rerank | **shelved** | 2026-08-05 |
| [D17](#d17-20k-per-page-crop-with-a-crop-position-shadow) | 20k per-page crop + crop-position shadow | adopted (experiment) | 2026-08-06 |
| [D18](#d18-targeted-reasoning-reasoning-only-on-research-turns) | Targeted reasoning (research turns only); since D37 nearly every turn is a research turn | **inconclusive** | 2026-09-19 |
| [D19](#d19-follow-up-re-search-prompt-nudge) | Follow-up re-search prompt nudge (only re-searching since D37) | adopted (soft) | 2026-09-19 |
| [D20](#d20-narration-strippers-strict-at-persist-best-effort-live) | Narration strippers: strict at persist, best-effort live; language-agnostic rules applied wherever text is read; stored history backfilled; a planning draft in front of a glued restart is cut (10-06: lab, staging and prod) | adopted | 2026-09-10 / 09-17 / 09-28 / 09-29 / 10-06 |
| [D21](#d21-other-latency-knobs-measured) | Other latency knobs measured (rerank budget, enrich cap, crawl parallelism, turn budget) | mixed | 2026-07/09 |
| [D22](#d22-multi-agent-deep-research) | Multi-agent deep research | **shelved** | 2026-08-04 |
| [D23](#d23-uploads-and-url-rag-on-disk-not-pgvector) | Uploads / URL RAG on disk, not pgvector | adopted | 2026-07-07 → 09-12 |
| [D24](#d24-the-embedding-model-is-data-locked) | The embedding model is data-locked | adopted | 2026-07-19 |
| [D25](#d25-signed-upload-urls-shipped-dormant) | Signed upload URLs, shipped dormant | adopted (dormant) | 2026-09-12 |
| [D26](#d26-model-manager-is-the-sanctioned-env-editor) | Model Manager is the sanctioned `.env` editor | adopted | 2026-08-09 |
| [D27](#d27-saved-model-pick-outranks-the-default) | Saved model pick outranks the default | adopted | 2026-07-23 |
| [D28](#d28-sidebar-refresh-invariants-and-uncached-conversation-reads) | Sidebar refresh invariants + uncached conversation reads | adopted | 2026-09-19 → 09-22 |
| [D29](#d29-stop-keeps-the-partial-answer) | Stop keeps the partial answer | adopted | 2026-09-22 |
| [D30](#d30-degoog-public-instance-kept-per-env-scrapers-disabled) | degoog: public instance kept, per-env scrapers disabled | adopted | 2026-08-01 / 09-07 |
| [D31](#d31-hands-free-voice-conversation-loop) | Hands-free voice conversation loop | **reverted** | 2026-08-22 |
| [D32](#d32-homepage-and-mobile-layout) | Homepage and mobile layout choices | adopted | 2026-08-20 → 09-22 |
| [D33](#d33-prod-rate-limiters-left-inert) | Prod rate-limiters left inert | adopted (declined fix) | 2026-08-11 |
| [D34](#d34-recall-rerank-deferred-not-aborted) | Recall rerank deferred (not aborted); pool 10 × 384 tokens (8 on prod and lab since 09-25) | adopted | 2026-09-23 / 09-25 |
| [D35](#d35-retire-and-remove-the-231-ask-stacks) | Retire and remove the .231 Ask stacks | adopted | 2026-08-27 → 09-24 |
| [D36](#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only) | Strip historical citation anchors; resolve citations per turn only (one resolver, N = position within that call, since 09-26) | adopted | 2026-09-24 / 09-26 |
| [D37](#d37-always-search-every-question) | Always search every question (forced first search; since 09-27 the first search, not the only one) | adopted | 2026-09-26 / 09-27 |
| [D38](#d38-ready-made-citation-handles) | Ready-made citation handles in the model-facing tool output (`CITATION_HANDLES`) | adopted | 2026-09-27 |
| [D39](#d39-every-local-redis-client-goes-through-local-redis-ts) | Every local Redis client goes through `lib/redis/local-redis.ts` | adopted | 2026-09-27 |
| [D40](#d40-quality-mode-read-pages-past-the-search-cap) | Quality mode: read pages past the search cap (fetch cap 8, search cap 10); the answer-step citation reminder stays off | adopted (reminder **shelved**) | 2026-09-30 |
| [D41](#d41-on-wsl-hosts-nothing-that-waits-for-docker-is-enabled-at-boot) | On WSL hosts, nothing that waits for Docker is enabled into `multi-user.target` | adopted | 2026-09-29 |
| [D42](#d42-near-duplicate-search-skip-only-for-true-repeats) | Near-duplicate search skip only for true repeats: exact, or cosine ≥ 0.90 with no new word or number (was cosine ≥ 0.92 alone) | adopted | 2026-10-01 |
| [D43](#d43-snippet-citations-measured-not-re-pointed) | Snippet citations: evidence telemetry only; in-page cite markers and automatic re-pointing measured and dropped | adopted (telemetry); two fixes **rejected** | 2026-10-01 |
| [D44](#d44-shortened-and-one-character-off-citation-ids-resolve) | Shortened and one-character-off citation ids resolve to the one call of the turn they name (`id-prefix`, `id-typo`) | adopted (lab, staging and prod) | 2026-10-06 |
| [D45](#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps) | After the search round cap, stop offering `search`; a model that calls it anyway, or (speed/balanced) uses tools on 4 more steps, gets answer-only steps | adopted (lab and staging; prod pending) | 2026-10-07 |

---

## Principles

### D1. Optimise the pipeline, not the answering model

- **Status:** adopted · **Date:** 2026-09-07 (standing rule since the latency work of late July)
- **Context.** Real prod telemetry (33 turns after the 2026-09-04 search rework) showed turns of
  60–269 s. The dominant cost was the answering model: `glm-5.3-flash:cloud` (then the default,
  ~73% of traffic) looped 3–6 tool calls with slow inter-step reasoning, while
  `deepseek-v4-flash:cloud` turns finished in 13–60 s. The owner switches answering models freely,
  sometimes per turn.
- **Decision.** The answering model is **not** an optimisation target. Every latency or quality
  change must be **model-agnostic**: smaller prompts, fewer tool rounds, faster/parallel stages,
  tighter retrieval, so that any model benefits. The model can be *mentioned* as context; it is not
  proposed as the fix. The internal **classifier** model is a fixed pipeline component and *is*
  fair game ([D6](#d6-classifier-on-a-cloud-model-with-expansion-fused-in)). Reasoning effort is a
  per-request parameter applied to any model, so it counts as a pipeline lever
  ([D10](#d10-answering-model-reasoning-off-by-default)).
- **Evidence.** D5–D9 each cut a measured stage without touching the model. After them, the
  residual prod latency is the model's own reasoning plus tool-loop variance.
- **Consequences.** "Just switch the default model" is off the table. `answer_wait_ms` in the
  `[latency]` line under-counts model time (it only sees the final wait), so model cost is always
  larger than the line suggests. See [telemetry](/operations/telemetry).
- **Revisit if** the owner wants to fix the answering-model roster. Even then, change the
  **default** in `.env` and remember [D27](#d27-saved-model-pick-outranks-the-default): saved picks
  outrank it.

### D2. Lab first, and env-flag isolation (no per-env builds)

- **Status:** adopted · **Date:** 2026-08-01 (separate worktrees); lab reconciled 2026-08-22
- **Context.** Before 2026-08-01, prod and staging built from the same directory, so "test on
  staging first" only isolated env vars and rebuild timing, never code. Staging's
  `docker-compose.admin-feature.yaml` is an **overlay**: it has no `build:` or `image:` key and
  inherits `build: context: .` from the base (prod) compose.
- **Decision.**
  1. Architecture changes are built and measured on **lab** (`ask-flow`, branch `flow-design`,
     `:3742`) first. Only a measured, isolated win is ported, as its own commit, to staging
     (`admin-feature`) and prod (`dev`). Bug and cost fixes that are not architectural may go
     straight to staging → prod.
  2. Anything that must behave differently per environment goes behind an **env var read at
     runtime**. Examples: `SEARCH_EXCERPTS_ENABLED`, `SEARCH_QUALITY_FILTER`,
     `CLASSIFIER_MODEL_ID`, `SEARXNG_CRAWL_MULTIPLIER`, `ANSWER_THINK`.
- **Evidence.** `needsSources` ([D3](#d3-needssources-skip-retrieval-for-stable-knowledge)) came
  out of a lab pipeline experiment. Only the one component that measured positive was ported; the
  architecture around it stayed on lab. The staging A/B of excerpts had compared identical arms
  because prod and staging held the same flag value (`6366a90b` message).
- **Consequences.**
  - An **unflagged** code change reaches prod at prod's next rebuild. It does not stay on staging.
  - Before trusting an A/B, check whether the arms differed in **code** or only in **flags**.
  - Lab only receives prod's changes if someone merges them back. On 2026-08-22 `dev` was merged
    into `flow-design` (`dd7e0ca1`) because 34 genuinely lab-only commits had built on stale code
    and prod-only work (tap-vs-hold voice, auth hardening, fleet-boot self-heal) was missing from
    lab. **Back-merge prod → lab periodically.**
  - `NEXT_PUBLIC_*` flags are inlined at build time from the worktree `.env`. They are not runtime
    flags: changing one needs a rebuild.
- **Revisit if** a feature ever needs a genuinely different image per environment. That would need
  a `build:` key per overlay, and it breaks the "one image, flags differ" model.

### D3. `needsSources`: skip retrieval for stable knowledge

- **Status:** **reversed 2026-09-26 (owner)** by [D37](#d37-always-search-every-question) ·
  **Date:** 2026-07-30 · **Commit:** `74062395`. The gate is still in the code and comes back
  with `ALWAYS_SEARCH=off` (see "Reversal" below).
- **Context.** Every turn searched, including "explain closures in JavaScript".
- **Decision.** The classifier emits `needsSources: true` only when the answer turns on specifics an
  expert could not state from memory (a version, price, date, statistic, or named
  product/paper/event). A turn with `needsSources=false` **and** `needsRecent=false` gets
  `STABLE_KNOWLEDGE_PROMPT`, with `search` left out of `activeTools` but kept in the tools map as an
  escape hatch. `skipSearch` ("already answered in this conversation") wins over it. Implemented
  as `resolveTurnMode()` in `lib/agents/researcher.ts`.
- **Evidence.** A blind pairwise judge (sides swapped; a win counts only when both orderings agree)
  over 46 multi-turn pairs scored **13W-2L-3T** on the turns where the gated system chose *not* to
  search (net +11). It lost where both searched (−4) and where neither did (−2). All of the
  advantage came from the decision not to search. Answers to settled questions that did search came
  back padded with citations to introductory pages.
- **Consequences.** Four safeguards stop this failing closed. The `researcher()` parameter defaults
  to TRUE. The classifier's failure fallback is TRUE. Bypassed turns (URL, Retry) are TRUE. And
  `search` stays callable, because `activeTools` is advertising, not enforcement.
- **Revisit if** judged answers (not counts) show the gate withholding retrieval where it should
  not. See D4.
- **Reversal (2026-09-26, owner decision).** The prod record over the 60 days before the change
  showed what the gate was withholding: of 164 turns, 69 used no tools, 20 of them `skipSearch`
  turns and 47 `stable-knowledge` turns (`lib/agents/query-classifier.ts:217-221`,
  `lib/agents/researcher.ts:199-204`). Many asked about named products, company policies, home
  repair and cleaning, health and safety, or current fiction, and were answered confidently from
  memory. One answer about melted plastic on an oven tray recommended acetone with no fire
  warning. D3's evaluation judged answer style on settled concepts; it did not cover these
  questions. The owner ruled that correctness and safety on such questions outweigh the padding
  D3 avoided, so every question now searches ([D37](#d37-always-search-every-question)).
  - **What still exists.** `resolveTurnMode` keeps the gate after the flag check
    (`lib/agents/researcher.ts:210`), `STABLE_KNOWLEDGE_PROMPT` is unchanged, and the old
    classifier prompt is kept verbatim as `LEGACY_CLASSIFIER_SYSTEM_PROMPT`
    (`lib/agents/query-classifier.ts:165`). The classifier still emits `needsSources`; with the
    flag on it is logged and gates nothing.
  - **Revert switch.** Set `ALWAYS_SEARCH=off` in the environment and force-recreate `ask` (no
    rebuild). That restores the legacy prompt and this gate exactly. Details in D37.

### D4. Judge answers, not source counts

- **Status:** adopted (method) · **Date:** 2026-08-01
- **Context.** A full day went into "the `needsSources` gate suppresses 61–77% of operational
  questions; 0 sources is obviously bad." Three mechanisms were built on that inference: gate
  confirmation, an operational-task override and a softened prompt.
- **Decision.** Never conclude that a retrieval decision is wrong from source counts, tool-call
  counts or gate rates. Judge the **answers** blind and pairwise on the turns the change actually
  touches. Enforce a validity filter (both arms really were in the contrasting states) and split
  results by question class.
- **Evidence.** The first time answers were judged (21 valid first-turn pairs), forcing those turns
  to retrieve scored **1W-7L-3T** on operational questions and 1W-8L-1T on concept questions: the
  opposite of the inference. Gate rates measured on bare questions overstated reach 4–5×. Replaying
  real conversations gave 34% overall (75% first turns, 30% follow-ups). A single "0 → 37 sources"
  observation did not reproduce; the underlying rate was about 1 in 7.
- **Consequences.** Eval harnesses live under `scripts/eval/`. Live-search A/Bs are noisy (search
  non-determinism, the agent's choice to search or not, the ceiling on mainstream queries). Prefer
  deterministic benchmarks or prod passage-position logging.
- **Later result.** The 2026-09-26 A/B behind [D37](#d37-always-search-every-question) used this
  method (validity filter, both orderings) and went the other way on a small sample: forced search
  2W-1L-3T over 6 valid pairs. The evaluations above were larger. Neither settles the question on
  its own; D37 was decided on correctness and safety grounds.
- **Revisit if:** never. This is a method, not a feature.

---

## Search pipeline and latency

### D5. Source tiering by search mode

- **Status:** adopted · **Date:** 2026-09-02 → 09-03 · **Commits:** `8162458d` (speed fast path),
  `8f4ca45a` (speed bypasses classifier + recall), `4002980f` (tiers), `4617678e` (crawl Brave)
- **Context.** Every mode ran the same fan-out and crawl, so "Speed" was not fast. Crawling was the
  bulk of balanced latency.
- **Decision.**
  - **speed** = Ollama web search only, **no crawl**, local bi-encoder passage selection (not the
    remote cross-encoder, which added 5–7 s). Skips the classifier and recall; the researcher agent
    rewrites its own follow-up queries.
  - **balanced** = content-bearing APIs only (Ollama web, Tavily, Brave, LangSearch). Their API
    content is prefetched; minimal crawl.
  - **quality** = balanced + SearXNG + degoog, and crawls those link-and-snippet sources.
  - `searchMode` is forwarded to `/api/advanced-search` and is part of its Redis cache key, so
    balanced and quality results never cross-serve. Undefined/legacy callers behave like quality.
- **Evidence (lab).** Speed: 24.7 s (and broken) → **6.9 s**, prompt 89k → 16k tokens. Balanced
  advanced stage ~8 s with `crawl_ms:0`, against 26–48 s for quality; both grounded.
- **Consequences.** Brave's API only returns 1–2-sentence descriptions, too thin to pass prod's
  strict quality filter (>50 words), so Brave URLs are **crawled**, not prefetched. That
  re-introduced crawl cost on balanced; see D7. Details: [search pipeline](/search/pipeline).
- **Revisit if** a provider starts returning full page bodies (it could then be prefetched), or
  quality mode's 26–48 s becomes unacceptable.

### D6. Classifier on a cloud model, with expansion fused in

- **Status:** adopted · **Date:** 2026-09-04 (model swap); fusion earlier
- **Context.** The pre-search classifier decides `skipSearch` / `needsSources` / `needsRecent`,
  rewrites follow-ups into a standalone query, and emits expansion queries, all **in one call**.
- **Decision.** `CLASSIFIER_MODEL_ID = deepseek-v4-pro:cloud` in all envs (it was
  `glm-5.3-flash:cloud`). The standalone `query-expander.ts` on local granite is only the fallback.
- **Evidence.** A bake-off across all 7 stack cloud models through a direct `classifyQuery` harness
  (no live searches). deepseek-v4-pro was the fastest *usable* model: 925 ms isolated, ~1.1–1.3 s
  in a real turn, gating identical to granite, and better follow-up rewrites. glm took ~2.2 s and
  spiked to ~10 s on rewrite+expansion follow-ups. kimi-k3 and minimax were disqualified (empty or
  failed tool calls); qwen3.5:397b and kimi-k2.6 were slower. End-to-end balanced A/B: −1.3 s on
  fresh turns, −8.6 s on follow-ups.
- **Rejected along the way.** Splitting expansion out of the classifier so it could "overlap" the
  search would **regress**: expansion is already fused (`expand_ms≈0`), and the primary advanced
  search does not block on it. An earlier cloud-classifier trial on kimi-k2.6 was reverted on
  staging (`16854f60`: no warm speedup, 21 s cold, routing drift).
- **Consequences.** On prod the real classify time is ~4.6 s median, not 1.1 s, because balanced
  turns also generate the fused expansion. Hence the soft budget in D8. **Gotcha:** staging and lab
  hard-code `CLASSIFIER_MODEL_ID` in their compose overlays, and overlay `environment:` beats
  `.env`. Changing it needs prod `.env` **and** an overlay edit + commit.
- **Revisit if** the classifier model is delisted or slows down. Re-run the harness; don't
  A/B it live.

### D7. Cap the Brave crawl to the top 3

- **Status:** adopted · **Date:** 2026-09-07 · **Commit:** `2f25aa21` (lab `ccfd7500`)
- **Context.** After D5, balanced crawled all ~10 Brave URLs: `crawled=10 crawl_ms=17307` on prod,
  which roughly undid balanced's no-crawl win.
- **Decision.** `BRAVE_CRAWL_MAX` (default 3) crawls Brave's top N by Brave's own rank. The rest
  join `prefetchedUrls`. `0` prefetches all of them.
- **Evidence (lab).** Balanced crawl 17,307 ms (10 pages) → 1,099 ms (2 pages); grounding held (15
  citations, 0 unresolved).
- **Revisit if** balanced answers start missing facts that only lower-ranked Brave pages carried.

### D8. Timebox recall, classifier and LangSearch

- **Status:** adopted · **Date:** 2026-09-07 · **Commit:** `442b5dcd`; observability `79fecb19`
- **Decision.** Three env-tunable caps, all model-agnostic:
  - `RECALL_BUDGET_MS=1500`: critical-path past-conversation recall races this budget. Lab: recall
    wait 5.8 s → 1.5 s, TTFT **7.7 s → 3.6 s**. It drops past-conversation personalisation on slow
    turns only; web grounding and citations are a separate path and are unaffected.
  - `CLASSIFIER_BUDGET_MS=4000`: soft cap under the 10 s hard timeout, aimed at the ~18% of
    classifications that were slow. On budget it falls back gracefully and logs
    `outcome:'budget'`.
  - `LANGSEARCH_TIMEOUT_MS` 10000 → 2500: LangSearch had been gating the concurrent fan-out at
    ~4.7 s. Note that its real response is ~2.8 s, so 2.5 s makes it drop out most of the time.
    That is acceptable as a best-effort source.
- **Evidence.** Unit tests plus a live lab repro (a slow classifier pinned, budget lowered) proved
  the budget fires. Live recall: `recall_wait_ms:1501` capped against a true `recall_ms:3229`.
- **Lesson (false alarm, 2026-09-08).** The Redis `latency:log` **persists across deploys**, so it
  mixes pre- and post-deploy turns. Slow classifications that "proved" the budget broken were all
  from before the deploy. When verifying a shipped change, filter to entries carrying a field that
  only the new code emits. `latency:log` is written with `LPUSH`: **newest at the head**, so
  `LRANGE latency:log 0 N` gives the most recent turns.
- **Revisit if** personalisation feels weak on slow turns (raise `RECALL_BUDGET_MS`), or
  classification quality drops because of budget fallbacks.
- **Update (2026-09-23).** The recall budget turned out to drop recall on most prod turns (true
  `recall_ms` about 5.5 s). Recall itself was made to fit the budget instead of raising it; see
  [D34](#d34-recall-rerank-deferred-not-aborted).

### D9. Search round cap, enforced inside the tool

- **Status:** adopted · **Date:** 2026-09-07 · **Commit:** `53f03c4f` (lab `fb78c847`)
- **Context.** After D5–D8, real balanced turns still looped up to **7** `search` calls (~15 s
  fan-outs plus ~57 s of inter-call model reasoning).
- **Decision.** `SEARCH_ROUNDS_MAX` (default 3) and `SEARCH_ROUNDS_MAX_QUALITY` (default 5; 10
  since 2026-09-30, see the update below). The
  cap is enforced **inside the search tool's `execute`** (`lib/tools/search.ts:307-434`) with a
  per-turn counter in the `createSearchTool` closure. Past the budget it returns a non-error
  "answer from what you have" result (no fan-out, no crawl) and logs `kind:'round-cap'`.
- **Why inside the tool.** In AI SDK v6, `activeTools` only filters which tool **definitions** are
  sent to the provider. Execution resolves against the full `tools` map, and a withheld tool can
  still run. On lab, kimi-k2.6 called `search` with `activeTools: []`; the SDK ran it, and with
  `maxSteps: 1` the turn ended with a zero-character answer after 32 s. `ai-sdk-ollama` also
  silently drops `toolChoice`, so `toolChoice:'none'` is no alternative. **To really block a tool,
  remove it from `tools`**, and keep a step floor of 2 with a tool-free final step.
- **Evidence (lab, glm pinned to reproduce a loop).** The capped round was redundant: the answer
  kept every facet and all citations resolved. `prompt_tokens` 93k → 53k (**−43%**),
  `search_ms` −35%. Single-turn `total_ms` is confounded (the cap removes work but cannot shorten
  the model's own reasoning); the payoff shows in the aggregate.
- **Consequences.** It interacts with [D10](#d10-answering-model-reasoning-off-by-default): a
  model that hits the cap may "reason aloud" into the answer text. See D20.
- **Revisit if** multi-hop questions start failing because 3 rounds are not enough (raise the env,
  don't remove the cap).
- **Update 2026-09-30** ([D40](#d40-quality-mode-read-pages-past-the-search-cap)). The quality cap
  is **10** (`lib/tools/search.ts:315`), and a round is now counted only for a search that
  runs: a near-duplicate skip no longer uses one (`:562-564`). In quality mode the cap ends the
  searching, not the reading: the notice lets the model `fetch` URLs this turn already found,
  bounded by a per-turn fetch cap (`FETCH_ROUNDS_MAX_QUALITY`, 8). Speed and balanced keep 3
  rounds and the "answer now" notice. Commits: prod `a6db72f1` + `30838a61` (lab `49379e09` +
  `98ba1d36`; staging `4b5f6fd3` + `7a2d74ba`).
- **Update 2026-10-01** ([D42](#d42-near-duplicate-search-skip-only-for-true-repeats)). The
  near-duplicate skip now fires only on true repeats (exact, or cosine ≥ 0.90 with no new word
  or number). About three in four true repeats it used to skip now run, and each uses a round
  of this cap; the old rule's false skips, which dropped real searches, are gone.
- **Update 2026-10-07** ([D45](#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps);
  lab and staging, prod pending). The refusal notice alone did not stop every model: one prod
  turn had 80 `search` calls refused. From the step after the first refusal `search` is no
  longer offered, and a model that calls it anyway, or in speed/balanced uses tools on
  `POST_CAP_TOOL_STEPS_MAX` (4) more steps, gets answer-only steps. The refusal inside the tool
  stays the backstop. Parallel calls in one step can still overshoot the budget
  ([known issue](/history/known-issues#parallel-search-calls-can-overshoot-the-round-cap)).

### D10. Answering-model reasoning OFF by default

- **Status:** adopted · **Date:** 2026-09-09 · **Commit:** `06bd780b` (rollback point `79fecb19`)
- **Context.** A single `deepseek-v4-flash:cloud` turn produced ~66k characters of raw
  chain-of-thought plus a ~17k answer, about 25k output tokens.
- **Decision.** `ANSWER_THINK=on|low|off` via `resolveAnswerThink()` in
  `lib/utils/ollama-think.ts`, threaded into `getModel()` in `lib/utils/registry.ts`. The code
  default is **off** (`ANSWER_THINK_DEFAULT = false`). `ANSWER_THINK=on` reverts per env.
- **Evidence.** Graded `low`/`medium`/`high` is a **no-op** on the fleet's cloud models
  (deepseek/kimi/minimax; only gpt-oss honours levels, and any truthy string means full
  reasoning). Only `think:false` cuts reasoning: **−13% to −42% completion tokens**, with quality
  held on the hard test case (correct, precise, ~30% shorter). The A/B only covered
  deepseek-v4-flash.
- **Side effects (found later).** Turning reasoning off does not remove the reasoning. It moves
  some of it into the visible text, and it makes some models lean on prior context instead of
  searching:
  1. **CoT leaking into answer text**, worst after a round-capped follow-up (a 28,843-char text
     part whose `##` heading only began at ~15k). Handled by D20.
  2. **Follow-up under-searching**: the model answers a follow-up that needs a new fact from
     context and invents citation anchors. Mitigated by D19.
  Both were model-specific (worst on the now-delisted `deepseek-v4-flash` and on glm).
- **Consequences.** The legacy `OLLAMA_THINK` is still honoured when `ANSWER_THINK` is unset. One
  pre-existing test still asserts the old "thinking ON" default (see
  [known issues](/history/known-issues#pre-existing-test-failures)).
- **Revisit if** the strippers turn into whack-a-mole, or a model on the roster gets visibly thin
  answers. Then consider [D18](#d18-targeted-reasoning-reasoning-only-on-research-turns), or
  `ANSWER_THINK=on` for that env.

### D11. Hide raw reasoning in the UI

- **Status:** adopted · **Date:** 2026-09-09 · **Commit:** `537fa8e6`
- **Decision.** `components/reasoning-section.tsx` renders a compact "Thinking…" / "Thought" pill
  instead of the collapsible raw chain-of-thought. The raw text never enters the DOM. This covers
  live, reloaded and research-grouped paths. Persistence is unchanged. The flag is
  `NEXT_PUBLIC_SHOW_REASONING` (build-inlined, default false); `=true` restores raw display after a
  rebuild.
- **Consequences.** Hiding is cosmetic; it does not make anything faster (the model still generated
  the tokens). The speed win is D10. The two are complementary.
- **Revisit if** users want to audit reasoning. Flip the flag and rebuild.

### D12. Single-pass search instead of the agentic loop

- **Status:** **reverted** (lab-only; never reached staging or prod) · **Date:** 2026-09-10
- **Idea.** Replace the agentic re-search loop with one round plus a wider parallel expansion per
  mode (4/6/8 variants) and a "search once, then answer" prompt.
- **Evidence.** A rigorous lab A/B: arms interleaved turn by turn, n=6, search cache flushed each
  turn, recall disabled, model pinned.
  - **No speedup.** Search stage 8.16 s against 8.62 s, a wash. Single-pass fired fewer searches
    (`search_ms` −39%), but the stage is **crawl- and rerank-bound**, and those were equal across
    arms.
  - **Multi-hop regression.** On a chained question (national parks → most visited → how to get
    there), single-pass under-verified and got the final hop wrong (drive time). The loop's reactive
    extra round caught it.
- **Decision.** Keep the loop, bounded by [D9](#d9-search-round-cap-enforced-inside-the-tool).

::: danger Do not retry unless…
…you have evidence that balanced latency is dominated by the **number of rounds**. It isn't: it is
crawl + rerank. The loop earns its keep on chained questions.
:::

### D13. Prompt caching on Ollama Cloud

- **Status:** **rejected** (nothing built) · **Date:** 2026-09-11
- **Evidence.**
  - Ollama Cloud exposes no controllable or reported prefix cache. Upstream issues `ollama#16714`
    and `#15758` were open, a subscriber's benchmark of exactly this agentic-loop case showed no
    cache benefit, and the cloud always reports `0 cached_tokens`. `ai-sdk-ollama` has no cache
    knob; only `think` is passed.
  - The prompt shape would not benefit much anyway. The reusable cross-turn prefix is ~3–4k tokens,
    about 4–10% of a turn, because each turn is dominated by that turn's own 40–90k search payload
    (see D14).

::: danger Do not retry unless…
…the provider documents and reports prefix caching (`cached_tokens > 0`). Even then, the payoff is
bounded by the ~4–10% stable prefix.
:::

### D14. History trimming

- **Status:** **rejected** — already done · **Date:** 2026-09-11
- **Finding.** `pruneMessages({ reasoning: 'before-last-message', toolCalls:
  'before-last-2-messages', emptyMessages: 'remove' })` in
  `lib/streaming/create-chat-stream-response.ts:460` already strips earlier turns' crawled pages
  from the live prompt from the next turn onward. A three-turn searching chat does **not** balloon
  to 120–270k tokens. The only residual slice maps onto the excerpts idea that already lost (D15).
- **Consequence.** The real lever is the **volatile suffix**: crop size, source count, rerank
  budget and round cap, all shipped.

### D15. Source excerpts instead of full pages

- **Status:** **rejected** · **Date:** 2026-08-01 · **Commit:** `6366a90b`
- **Idea.** Hand the model the top-3 reranked passages per source (`SEARCH_EXCERPTS_ENABLED`)
  instead of the full cropped page, to shrink prompts.
- **Evidence.** One build, flag toggled, same questions in the same order.
  - Per-step prompt size fell only **5%** (inside run-to-run variance). Per turn it went the other
    way: steps **+142%**, tool calls +225%, prompt tokens +90%, total time +17%. Given three
    passages, the model goes back and searches again.
  - **Citation without support** (the most dangerous failure mode, because it is invisible)
    reproduced on 2/2 probed turns. GPU specs and Next.js release claims were attributed to an
    unrelated Kubernetes page left over from an earlier turn.
  - Earlier "staging vs prod" comparisons had compared identical arms (both had the flag on).
- **Consequences.** Off on prod, staging and lab. The flag remains.

::: danger Do not retry unless…
…you are testing the spec's untried stop condition (raise `PASSAGES_PER_SOURCE`) **and** you judge
citation support per claim, not step or token counts.
:::

### D16. Two-stage full-content rerank

- **Status:** **shelved** (flag `SEARCH_FULL_CONTENT_RERANK`, off everywhere) · **Date:** 2026-08-05
- **Idea.** Single-stage rerank only scores each document's first `perDocCap` passages, so an
  answer in the tail of a page is invisible. `rerankFullContent` (`lib/embeddings/rerank.ts`) runs
  a coarse bi-encoder pass over the whole page, then a fine cross-encoder pass on the best
  candidates.
- **Evidence.** A deterministic benchmark (`lib/embeddings/__bench__/full-content-bench.ts`,
  against the real services). It recovered ~3/6 mid- and tail-excerpt cases, but the coarse
  bi-encoder still dropped the answer in about half of the tail cases, and one case **regressed**.
  Cost is 1.3–5 s for the coarse stage. The cross-encoder service truncates at `max_length=128`,
  which adds noise, and mainstream facts sit in the first 10k characters of authoritative pages
  anyway (ceiling effect).

::: danger Do not retry unless…
…you improve **coarse-stage recall** (bi-encoder passage selection) and validate it with **prod
passage-position logging** (see D17), not synthetic documents or live browser A/Bs. Search
non-determinism, the agent's search-or-not choice and the ceiling swamp live A/Bs.
:::

### D17. 20k per-page crop with a crop-position shadow

- **Status:** adopted (running as a real-traffic experiment) · **Date:** 2026-08-06 · **Commit:** `0e817799`
- **Decision.** `SEARCH_ENRICH_MAX_CHARS=20000` (was 10k) plus `SEARCH_CROP_POSITION_SHADOW=true`
  in the base compose (`${…:-20000}` / `${…:-true}`, shell-overridable). The shadow is
  measurement only: it runs after the response (`after()`), swallows errors and never changes
  answers (`lib/search/crop-position.ts`).
- **Evidence (lab).** 20k recovers ~22% of sources' best content (shadow tail-loss ~0.45 → ~0.2)
  with no visible TTFT hit, because TTFT is dominated by the crawl.
- **How to read it.** `docker logs ask | grep -E '\[crop-pos\]|\[cite-urls\]'` and join by
  `chatId`. The `t=1` fraction among **cited** URLs is the citation-scoped crop cost that decides
  10k vs 20k. The answer impact is limited, because only the one advanced search per turn is cropped.
- **Open.** Nobody has read the accumulated data yet (see
  [known issues](/history/known-issues#crop-experiment-data-unread)).
- **Revert:** `SEARCH_ENRICH_MAX_CHARS=10000` and recreate `ask`. Shadow off:
  `SEARCH_CROP_POSITION_SHADOW=false`.

### D18. Targeted reasoning (reasoning only on research turns)

- **Status:** **inconclusive** — built, gated, not ported · **Date:** 2026-09-19 · **Commit:** lab `68e3490d`
- **Idea.** `ANSWER_THINK=targeted` turns reasoning on only for `research` turns
  (`needsSources || needsRecent`) and keeps it off for direct/stable-knowledge turns. This aims at
  the root cause of both D10 side effects.
- **Evidence.** Lab A/B pinned to `deepseek-v4.1-flash`. **Neither bug reproduced** in either arm:
  blanket-off already searched ~100% of research follow-ups, with 0/12 leaks. So the A/B could only
  measure the cost: **~+14 s per research turn (+58–72% total), 2× completion tokens**. Quick and
  clarify turns were unaffected (~2.5 s).
- **Decision.** Do not pay +14 s for a problem that is not showing up on the current roster.
- **Revisit if** CoT leaks or under-searching return on the live roster. Re-run the A/B pinned to
  `glm-5.3-flash` with a turn that hits the round cap. The code is inert until
  `ANSWER_THINK=targeted` is set, and it exists only on `flow-design`.
- **Interplay with D37 (2026-09-26).** `targeted` keys on `turnMode === 'research'`
  (`lib/utils/ollama-think.ts:136-138`, lab only). With `ALWAYS_SEARCH` on, every turn except
  the few `direct` ones is a research turn, so `targeted` would now mean reasoning on for almost
  every turn, with the measured +14 s each. It is not the selective lever it was designed as. Re-think
  the trigger before trying it again. `ANSWER_THINK` is unset on all three envs (checked
  2026-09-26).

### D19. Follow-up re-search prompt nudge

- **Status:** adopted (soft lever) · **Date:** 2026-09-19 · **Commit:** `03e70c52`
- **Decision.** One conservative clause in `lib/agents/prompts/search-mode-prompts.ts`: a follow-up
  that needs a **new** fact, entity, number or date not already established is not
  "clarification", so search before answering. It is in the speed prompt and in the shared
  `getApproachStrategy`. The change is prompt text only, with zero latency cost.
- **Evidence.** It helps but guarantees nothing: kimi-k2.6 still under-searched 1 of 2 fresh-fact
  follow-ups. There was no over-searching on clarification turns, because the classifier routes
  pure clarification to `direct` before the prompt applies.
- **Revisit if** under-searching persists: D18 is the stronger lever.
- **Since D37 (2026-09-26).** Moot for the **first** search of a follow-up: every follow-up that is
  a question now gets a forced first search on the classifier's resolved query, whatever the
  prompt says. The clause still matters for whether the model searches **again** after that first
  result, so keep it.

### D20. Narration strippers: strict at persist, best-effort live

- **Status:** adopted · **Dates/commits:** `378e81af` (2026-09-10), `0290896c` (2026-09-17),
  `48d5b06d` (2026-09-28, [addendum](#addendum-2026-09-28-language-agnostic-structural-rules)),
  `6e19914f` (2026-09-28, [addendum › Decision 5](#decision-5-the-live-transform-cuts-the-glued-seam)),
  `d751352d` (2026-09-29, [addendum › Decision 6](#decision-6-the-glued-seam-wins-at-persist-too)),
  backfill tool `a59d0c65` (run 2026-09-28/29, [addendum › Backfill](#backfill-2026-09-28-29));
  lab `a6a9d6c0` / staging `1a43ef1c` / prod `20cb9cc1` (2026-10-06, [addendum › Decision 7](#decision-7-a-planning-draft-in-front-of-a-glued-restart-is-cut);
  prod rows backfilled 2026-10-07); earlier `f4c53a7a` (2026-07-08)
- **Context.** Reasoning models emit "process narration" such as "I have comprehensive data now…
  let me search…" or "The search limit has been reached (3 rounds)…" as text parts. Two families
  exist: separate inter-step text parts, and narration **fused into the final text part** (after
  D9 + D10).
- **Decision.** Three layers:
  1. `strip-narration-from-message.ts` (**at persist**): drop a non-final text part that is
     narration-shaped *and* followed by a later tool or text part.
  2. `strip-narration-preamble.ts`: a starter-phrase list (`NARRATION_STARTERS`, extended with the
     round-cap / limited-results / source-inventory family) plus a **structural backstop**
     `shouldStripPreamble`. It strips even an unlisted preamble when there is a `##` heading, the
     preamble is over 1,000 characters, and there is a strong reasoning signal (a stray think tag,
     or at least 3 first-person research sentences). Real intros are ≤~700 characters; the smallest
     real reasoning dump seen was ~8 KB. Also `stripStrayThinkTags`.
  3. `smooth-and-strip-narration.ts` (**live stream**, `experimental_transform`): buffers a
     plausible-narration prefix for a bounded time.
- **Why live is best-effort.** A live stripper has to decide from a **prefix**, before it knows
  whether a `##` answer follows. Being aggressive risks swallowing real answer text; a live
  stripper did exactly that in July (`f4c53a7a`, "silently dropping answers"). So the live
  transform is conservative, and a brief flash of narration on some models (seen on glm) is
  accepted. The persisted message is cleaned properly and replaces the live view on reload.
  The one exception is the glued seam (addendum, Decision 5): there the persist rule's guard can
  be settled from a prefix, so the live cut is exactly the persisted one.
- **Consequences.**
  - ~~Already-saved leaked messages stay leaked until regenerated. The strippers act at persist
    time.~~ **Corrected 2026-09-28:** the chat view, copy, the history fed back to the model and
    the classifier, the spoken gist, recall indexing and search snippets now apply the same
    cleanup when they read a message, so a saved leak **displays** clean. **Since 2026-09-28/29
    the stored rows are clean too:** a backfill rewrote staging and prod history and re-indexed
    the affected recall chunks ([addendum › Backfill](#backfill-2026-09-28-29)).
  - Residual by design: a final answer with fused narration and **no** `##` heading is left intact
    (rare, since prompts mandate the heading). Dropping it risks losing real content.
  - The rule "the answer is the text after the last tool part" is also used by
    `lib/memory/extract-indexable-text.ts`.
- **Revisit if** a new narration family appears. Add its starters and tests
  (`lib/streaming/helpers/__tests__`); don't loosen the structural thresholds without a corpus.
- <span id="addendum-2026-09-28-language-agnostic-structural-rules"></span>**Addendum
  2026-09-28: language-agnostic structural rules, applied everywhere text is read.** Commit
  `48d5b06d` (lab `5f8caf17`, staging `91d25f65`), ported to prod and staging the same day for
  release after a lab browser check.
  - **What leaked.** Prod chat `pq6zs7w88m1kmowjdu9udfrw` (deepseek-v4-pro, balanced,
    Vietnamese): its status notes before each tool call ("Tôi cần đọc trang này…") were saved,
    and two of its three answers ended their preamble with `…chương.</think>## 吞噬星空`, the
    third with `…câu trả lời.## ` (no tag, no newline). The markdown sanitizer drops the unknown
    `</think>` element, so users saw "…chương.## " in front of the answer. Three causes, all in
    the rules of 2026-09-10/17:
    1. The persist-time drop of a non-final text part (`strip-narration-from-message.ts`)
       required `looksLikeNarrationStart`, i.e. an English `NARRATION_STARTERS` match. Vietnamese
       and Chinese status notes, and English ones with unlisted wording ("Let me try…", "One more
       check…"), were kept.
    2. The fused-preamble cut required an English decider (`looksLikeReasoningPrefix` for the
       stray-tag cut, `shouldStripPreamble` for the heading cut) even when `findHeadingMatch`
       had found `</think>## `.
    3. A heading glued straight after a sentence was never recognised as a heading at all.
  - **Where it showed.** After a turn completes, `render-message.tsx` already hid every text
    part except the last, so the status notes were not visible in the chat view. They leaked
    into the history sent back to the model and the classifier (logged-in and guest), the copy
    shortcut (which joins every text part) and keyword-search matches and snippets. Recall never
    indexed them, because `extractIndexableText` keeps only the text after the last tool call.
    The glued preamble sits inside the final text part, so it was visible in the answer and
    reached everything that reads the answer: copy, the spoken gist, recall chunks, snippets
    and the history. During streaming the Vietnamese answer stayed hidden (it did not start with
    a heading), then appeared with its preamble.
  - **Decision 1: inter-step chatter in any language.** A non-final text part whose next
    significant part is a tool call is dropped when it is at most 600 characters, has no
    heading, table, code fence, list of 3+ items or citation marker, and is not longer than the
    final answer (`looksLikeInterStepChatter`, `lib/streaming/helpers/strip-narration-preamble.ts:595`;
    `lib/streaming/helpers/strip-narration-from-message.ts:115-125`). The English phrase rule
    still drops a narration part at any length. The final-answer guard protects "short real
    reply → side-effect tool → shorter sign-off". **Why 600:** in stored history (831 assistant
    messages, prod and lab), text written right before a tool call is 110–180 characters at the
    median and 250–460 at p90; every Vietnamese and Chinese one was 67–247. D20's genuine intros
    reached ~700 characters, so 600 covers the chatter with headroom and stays below that.
  - **Decision 2: the glued seam.** The first `## ` outside code whose preceding character is
    not whitespace, `#` or `\` is a seam (`findGluedHeadingSeam`,
    `lib/streaming/helpers/strip-narration-preamble.ts:292`). The prefix is cut when it has no
    heading or citation of its own, is at most 2000 characters and is shorter than the rest
    (`stripGluedHeadingPreamble`, `:356`; since Decision 5 built from the shared helpers
    `findGluedPreambleSeam`, `:309`, and `gluedAnswerOutweighsPreamble`, `:332`). A proper
    `\n\n## ` heading is never touched.
    **Why 2000:** the three prod preambles were 613, 653 and 673 characters (6–9 % of
    their answers); a stray glyph glued in front of a heading was 2; real reasoning dumps start
    around 8 KB and carry English starters. 2000 is about 3× the largest non-English preamble.
  - **Decision 3: English first, structure second.** Both rules run **after** the existing
    English rules (`stripNarrationPreamble`, `strip-narration-preamble.ts:631-640`; the
    phrase test is the first alternative in `strip-narration-from-message.ts:116-120`), so they
    only add removals and English behaviour is unchanged. One exception since 2026-09-29
    (Decision 6): a glued seam in front of the first line-start heading is decided by the glued
    rule alone.
  - **Decision 4: one cleanup wherever text is read.** The same pure functions now run in the
    chat view and the "research still running" indicator (`narrationCleanView`, memoized per
    message object, `components/render-message.tsx:54,158`), the copy shortcut
    (`components/chat.tsx:686`), the model and classifier history
    (`lib/streaming/create-chat-stream-response.ts:262`; guests
    `lib/streaming/create-ephemeral-chat-stream-response.ts:62`), the spoken gist
    (`lib/streaming/create-chat-stream-response.ts:963`), recall extraction
    (`lib/memory/extract-indexable-text.ts:135-142`) and keyword-search snippets
    (`lib/db/keyword-search.ts:76-79`). Stored messages therefore display clean without a DB
    rewrite. The live stream transform was left unchanged by this commit: it decides from a
    prefix, which is why live stays best-effort. Decision 5 (a follow-up the same day) moved
    the glued-seam cut, and only that cut, into the transform.
  - <span id="decision-5-the-live-transform-cuts-the-glued-seam"></span>**Decision 5: the live
    transform cuts the glued seam.** Prod `6e19914f`, lab `a3074f86`, staging `951b6a83`
    (2026-09-28).
    - **What went wrong.** Lab chat `bllkvux84ck1uz3wwrwnydg5` (deepseek-v4-pro), turn 2: the
      final answer opened with a 785-character English preamble glued to its heading
      (`…the detailed chapter breakdown.## Trận chiến…`). The preamble read as English narration,
      so the transform kept buffering, waiting for a line-start heading that never came
      (`findHeadingMatch` does not see a glued `## `). It held all 4,916 characters and emitted
      them as one delta at text-end: about 72 s with nothing on screen after the last tool call
      (as recorded in the commit). The render view could not help, because it had nothing to
      render.
    - **Shared helpers.** The persist rule was split in two
      (`lib/streaming/helpers/strip-narration-preamble.ts`): `findGluedPreambleSeam(text)`
      (`:309`) returns the seam when the prefix qualifies on its own (no line-start heading with
      code masked, no citation marker, trimmed prefix ≤ 2000); `gluedAnswerOutweighsPreamble(prefixLength, answer)`
      (`:332`) is the remaining guard. `stripGluedHeadingPreamble` (`:356`) is built from the
      two, with unchanged behaviour. The seam and prefix guards depend only on the text up to the
      seam, so they can be evaluated on a partial buffer.
    - **Exact release rule, not an approximation.** On every held delta the transform
      (`lib/streaming/helpers/smooth-and-strip-narration.ts:98-127`) looks for a qualifying seam.
      When one exists and comes before any heading `findHeadingMatch` finds, it emits
      `buffer.slice(seam)` as soon as the answer after the seam outweighs the prefix, then passes
      later deltas through 1:1. **Why this point:** the trimmed answer only grows, so once the
      partial answer outweighs the prefix the final one must too, and the live cut equals the
      cut persist makes. Releasing earlier could drop a prefix that persist keeps (a long
      preamble in front of a short answer). The `</think>## ` and `<channel|>## ` shapes keep
      the old heading path: there the seam and the matched heading are the same `##`.
    - **Backtick wait.** If a backtick precedes the seam on its line, the transform also waits
      for that line to end (`:109-112`): a closing backtick later on the line would make the
      `##` inline code, and there would be no seam.
    - **A seam before a later heading wins** (`:100-104`). With `narration.## A … \n## B` the
      phrase rule would cut at `\n## B` and eat the glued first section.
    - **Undecidable → hold, as before.** While the answer after the seam is still no longer
      than the prefix, or the backtick line has not ended, the transform keeps holding, bounded
      by `NARRATION_HARD_MAX` (16,000 characters, `:24`); a part that ends first is flushed
      unchanged at text-end (`:163-175`).
    - **Scope.** The cut needs the part to still be buffered when the seam arrives: an
      English-looking preamble, or a seam within the first ~64 characters
      (`NARRATION_SNIFF_LIMIT`, `:15`). A longer non-English glued preamble is still released
      after ~64 characters and is cut by the render view and at persist, at the same point.
    - **Also fixed.** The line-start-heading path no longer `.trim()`s the partial buffer
      (`:136-143`). When the heading was recognised on the delta that ends with its newline,
      the trim dropped that newline, so the stream, and the saved answer, read
      `## Remedying Canker SoresCanker sores are painful.`
    - **Evidence.** A replay of the real turn-2 text, re-cut with turn 1's recorded chunk sizes
      (turn 2 was captured as a single delta, because the bug collapsed it): the answer is
      released 792 characters after the seam, i.e. the first emission comes after 1,577 of
      4,916 raw characters, and the remaining 3,339 stream progressively. Bound: the first
      emission comes on the delta that takes the trimmed answer past the prefix, so at most one
      delta after prefix + 1 characters (the backtick wait aside), and the prefix is at most
      2000 characters. Tests: `lib/streaming/helpers/__tests__/smooth-and-strip-narration-replay.test.ts`
      with fixtures `lib/streaming/helpers/__tests__/fixtures/narration-replay-t{1,2}.json`. Under
      six chunkings (turn 1's sizes, one character per delta, a single delta, three seeded random
      cuts) the output is `raw.slice(785)` and equals the persisted cleaned text; turn 1, whose
      answer starts with a proper `## `, comes out chunk-for-chunk as recorded. Guards in
      `smooth-and-strip-narration.test.ts`: `##` and its space in different deltas, the seam
      before a later heading, holding while the answer is shorter, the backtick wait, the 2000
      bound, a citing prefix, and never cutting `##` in code, `###`, `\##`, a real intro or a
      heading-less answer.
    - **Open edge (closed 2026-09-29 by Decision 6).** `stripNarrationPreamble` ran the
      English phrase rule before the glued rule, so raw text shaped `narration.## A … \n## B`
      that reached persist unstripped (an undecidable seam, or a non-narration-looking
      preamble released after the first 64 characters) could lose section A.
  - <span id="decision-6-the-glued-seam-wins-at-persist-too"></span>**Decision 6: the glued seam
    wins at persist too, and two more English starters.** Prod `d751352d`, lab `0cb22cf9`,
    staging `95c73f74` (2026-09-29).
    - **Seam precedence.** `stripNarrationPreamble`
      (`lib/streaming/helpers/strip-narration-preamble.ts:631-640`) first removes stray
      think-tag reasoning, then asks `gluedSeamLeads` (`:613-618`): is there a qualifying glued
      seam (`findGluedPreambleSeam`) before the first line-start heading? If so the glued rule
      alone decides (cut at the seam, or keep the text); the phrase rule never runs, so it
      cannot cut at the later `\n## B` and take section A with it. Otherwise the order is
      unchanged: phrase rule, then the glued cut on what remains. This is the precedence the
      live transform already applied (Decision 5), so live, persist and the render view make
      the same cut.
    - **English starters** (`NARRATION_STARTERS`, `:18`; the new patterns at `:25` and `:31`): "I have converging / convergent /
      corroborating evidence…", and "I'm ready to write / compose / draft / synthesize / put
      together / deliver / give / provide the (final / full / complete / comprehensive)
      answer / response / reply" with an optional "ok / alright / now / so" lead. The object
      must be **the/my answer/response/reply**, so user-facing offers ("I'm ready to help",
      "I'm ready to write your cover letter") never match. Both phrasings were seen on prod
      (2026-09-08).
    - **Evidence.** A scan of every stored message on prod, staging and lab with the new rules:
      exactly **1** message changes (a prod answer, 127 characters of preamble), and no real
      content is removed. That message was cleaned in storage the same day by a second
      backfill run (below). Tests: `lib/streaming/helpers/__tests__/strip-narration-preamble.test.ts`,
      `strip-narration-structural.test.ts` (the `## A … \n## B` shape) and
      `smooth-and-strip-narration.test.ts`.
  - **Evidence for Decisions 1–4 (read-only scan of the last 60 days).** Non-final text parts
    followed by a tool call:

    | Env | Language | Parts | Already dropped (old rules) | Leaked |
    |---|---|---|---|---|
    | prod | en | 50 | 34 | 16 |
    | prod | vi | 9 | 0 | 9 |
    | lab | en | 105 | 79 | 26 |
    | lab | zh | 1 | 0 | 1 |

    Glued seams: prod 3, all Vietnamese, all leaked. With the new rules the prod messages the
    cleanup changes go from 26 to 38 (57 parts dropped, 3 answers cut). All 88 new removals
    across stored history (15 Vietnamese, 73 English) were reviewed by hand: **0 false
    positives**. English regression check: of the 118 messages the old rules changed, 95 are
    identical under the new rules, 23 are cleaner, 0 regressed. 6 long or list-shaped
    narration parts are kept by design. Tests:
    `lib/streaming/helpers/__tests__/strip-narration-structural.test.ts` (fixtures from the prod
    chat, plus Chinese, Spanish and false-positive guards).
  - **Limits** (tracked in [known issues](/history/known-issues#narration-the-structural-rules-keep-by-design)):
    during streaming a glued answer appears only once its body outweighs the preamble (no
    flash; until Decision 5 an English-looking one was held until the part ended); non-English
    narration before a proper `\n\n## ` heading is not cut (0 cases in the data). (Keyword
    search matching stored chatter and recall chunks holding a glued preamble were limits until
    the 2026-09-28/29 backfill below.)
  - <span id="backfill-2026-09-28-29"></span>**Backfill: done 2026-09-28/29.** Stored history
    on staging and prod was cleaned with the app's own code, and the affected recall chunks
    were re-indexed. Tool: `scripts/backfill-narration.ts` (+ `scripts/backfill-narration-plan.ts`,
    run through `scripts/backfill-narration.sh <env>`); prod `a59d0c65`, lab `449d8d3e`,
    staging `736faf57`. How it works and how to re-run it:
    [evaluation › data scripts](/operations/evaluation#narration-backfill),
    [runbook](/operations/runbooks#re-run-the-narration-backfill).
    - **Why a new tool, not `clean:narration`.** `scripts/clean-narration-preambles.ts` runs
      the per-part preamble rule over every text part, user messages included, never drops a
      status-note part and never re-indexes recall. The backfill runs the whole message
      cleanup (`buildUIMessageFromDB` → `stripNarrationFromMessage`, exactly what the reader
      renders) on assistant messages only, turns the difference into text-row deletes and
      rewrites, and self-checks each plan: applied and mapped back, the rows must equal the
      render view, and that view must already be clean, so a re-run finds nothing.
    - **Why one transaction per message.** Each message is independent and self-verifying, so
      a failure rolls back only that message and leaves every other one fully old or fully
      clean, a state an idempotent re-run continues from. The message row is locked `FOR
      UPDATE`, which serialises against the app's own `upsertMessage`, and locks stay short on
      a live database.
    - **Run 2026-09-28** (dry run → backup → apply → verify → re-index, one env at a time):

      | Env | Messages | Part deletes | Rewrites | Chars removed | Recall re-indexed | Chunks with removed text |
      |---|---|---|---|---|---|---|
      | staging | 99 | 242 | 5 (4 messages) | 75,923 | 4 messages, 23 → 14 chunks | 7 → 0 |
      | prod | 92 | 177 | 4 | 35,738 | 8 messages, 68 → 56 chunks | 3 → 0 |

      On prod 88 of the 92 messages were saved before 2026-09-17 (when the last English rule
      landed) and 36 in the last 60 days; on staging all 99 predate 2026-09-17. Verify through
      the app's loader: 99/99 and 92/92 equal the render view. A dry run afterwards finds 0
      changes (prod 435 assistant messages scanned, staging 509). A second re-index pass
      re-indexed nothing. Messages whose chunks differ only for unrelated reasons (prod 2) and
      messages never indexed (prod 3) are left alone.
    - **Run 2026-09-29, prod only**, after Decision 6: 1 message, 1 rewrite (127 characters),
      its 4 recall chunks re-indexed (the one holding the removed text → 0); verify 1/1; a dry
      run afterwards finds 0 of 435. Staging and lab had nothing to change under the new rules.
    - **Backups** are in `~/selfhosted/backups/narration-backfill/` on .17 (mode 0600, full
      rows of every changed part and every recall chunk of every changed message). They hold
      user content: do not copy them off the host or print them. Each 2026-09-28 backup also
      has a `<backup>.restore.sql` next to it: one transaction that raises an error unless the
      connected cluster's `system_identifier` matches the backed-up one, re-inserts the part
      rows (restoring rewritten text on conflict) and replaces the messages' recall chunks. The
      script does not generate these files; they were written alongside the run, and the
      2026-09-29 backup has none.
  - **Don't** raise 600 or 2000 without re-running the corpus review, and don't cut a
    non-English intro before a proper `\n\n## ` heading on a guess: that is exactly where
    genuine intro prose lives.
- <span id="decision-7-a-planning-draft-in-front-of-a-glued-restart-is-cut"></span>**Addendum
  2026-10-06 (Decision 7): a planning draft in front of a glued restart is cut.** Lab
  `a6a9d6c0`, staging `1a43ef1c`, prod `20cb9cc1`. **Status: lab, staging and prod**; the 4
  affected prod rows were backfilled on 2026-10-07 (backup, apply, verify 4/4, re-index). It shipped together with the citation resolver
  repair ([D44](#d44-shortened-and-one-character-off-citation-ids-resolve)); see "Why it ships
  with D44" below.
  - **What leaked.** Prod chat `mzwbeqoe15wgh12et66fybzo` (glm-5.3-flash, 2026-10-06), 4
    answers. The model wrote its plan into the final text part: an outline of the answer with
    its own `## ` headings, scratch notes on the prompt's mechanics ("Available cite strings
    (toolCallIds) in this turn…", "Related questions spec block? … skip"), then the real answer
    glued to the last note (`…at end.## Why…`, `…per rules).</think>## Re-enabling…`). The
    drafts were 2.0–15.1 KB. The glued rule (Decision 2) refuses a prefix with a heading of its
    own (there it would be a missing newline inside an answer) and stops at 2,000 characters,
    so all four drafts were shown and saved as part of the answer.
  - **Decision: cut at the glued seam on evidence that the prefix is scratch work.**
    `findDraftRestartSeam` (`lib/streaming/helpers/strip-narration-preamble.ts:537-563`) finds
    the seam and `stripDraftBeforeRestart` (`:571-574`) cuts there. `stripNarrationPreamble`
    calls it right after `stripStrayThinkTags` (`:637`), so persist, the render view, the
    history fed back to the model, copy, the spoken gist, recall indexing, keyword-search
    snippets and the narration backfill all make the same cut. The rule is written up in the
    block comment at `:364-399`. All four conditions must hold:
    1. The prefix's prose (code masked) uses the prompt's internal vocabulary,
       `SCRATCH_TOKEN_FAMILIES` (`:408-419`), one regex per family: `toolCallId(s)` /
       `tool_call_id`; the placeholder `[n](#…` / `[number](#…`; an id elided inside an anchor
       (`](#71cee5ba...)`, `](#74661147-…)`); "cite string(s)" / "cite id(s)"; "spec block" /
       "related-questions block". An answer has no reason to use any of them.
    2. The cut is the first glued `## ` **after the last such token anywhere in the text**, code
       included, so the kept answer never contains one. An answer about Ask or about tool calling
       that uses the words after the seam is never cut.
    3. The kept answer has at least `DRAFT_ANSWER_MIN` = 400 non-space prose characters (code
       masked, `:433`), so a long message is never reduced to a stub such as a trailing glued
       `## Related` section. The four answers carried 1.5–6 K.
    4. An independent second signal. A prefix with headings of its own (line-start, or glued
       earlier) must be an outline **of** the answer: one of its headings is restated by one of
       the answer's, at a character-bigram Dice similarity of at least `HEADING_RESTATED_MIN` =
       0.8, on headings of at least `HEADING_COMPARE_MIN_CHARS` = 8 normalized characters
       (`:440-441`), with the same numbers in both (sibling sections such as "Part 1" / "Part 2"
       score 0). The four drafts' outline-to-answer pairs scored 0.83–0.95. A prefix with no
       heading has no outline to compare, so it must use at least `NO_OUTLINE_MIN_FAMILIES` = 2
       vocabulary families (`:425`) and cite nothing; an elided `[1](#71cee5ba...)` is a note
       about a citation, not one (`ELIDED_ANCHOR`, `:427`).
  - **Deliberately not vocabulary:** "citation mapping" (a bibliometrics term) and a shortened id
    inside an otherwise valid anchor (`[2](#a1bf94e4)`), which real answers on several models
    contain.
  - **Why the glued seam stays required.** A `## ` fused to a sentence never renders as a
    heading, and it is where these drafts end. With a proper `\n\n## ` restart the vocabulary
    alone would have to decide, and an answer about Ask's own citations can use it.
  - **Why the live transform is unchanged.** An outline draft opens with `## ` like any answer, so
    the transform could not hold it without holding every answer, and condition 2 depends on
    text after the seam that has not streamed yet. While the answer streams, the draft is
    therefore shown: the render view displays it (it starts with a heading) until the answer
    after the seam reaches 400 prose characters (and, for an outline draft, a heading that
    restates the outline has arrived); from then on `narrationCleanView` shows only the answer.
    The saved message is cut at persist. A heading-less draft that opens with English narration
    is held by the transform as before and flushed unchanged at the end of the part, and the
    render view then cuts it. Tracked as a
    [known issue](/history/known-issues#a-planning-draft-shows-while-the-answer-streams).
  - **Evidence.** A replay over every stored assistant text part (prod 495, staging 522, lab
    425) cuts exactly the 4 prod answers and nothing else. 72 English answers that discuss
    citations or tool calls, and all 46 Vietnamese answers, are untouched. A deliberate worst
    case (a glued heading plus injected vocabulary in 498 real answers) left 1 residual cut,
    from parallel headings that score as a restatement ("The external rotation half" /
    "The internal rotation half"). Tests:
    `lib/streaming/helpers/__tests__/strip-narration-draft.test.ts` (fixtures trimmed from the 4
    prod answers, the unchanged live transform, false-positive guards).
  - **Limits.** A draft followed by a proper `\n\n## ` restart is not cut (0 cases in stored
    history). Separate and unchanged: a long reasoning part in the middle of a turn (over 600
    characters, or structured) is kept by design, as above.
  - **Why it ships with D44.** The glm anchors that D44's prefix repair recovers sat in this
    leaked planning text (43 of the 48 anchors glm-5.3-flash lost on prod since 2026-10-04). The
    resolver fix alone would have rendered them as source chips inside a draft the reader should
    not see; with the draft cut, they go with it.

### D21. Other latency knobs measured

| Knob | Result | Status | Evidence |
|---|---|---|---|
| `RERANK_PASSAGE_BUDGET` 320 → 160 | −40% (~5 s) rerank, ~2.6 s off the turn, answers judged comparable on 3 searching prompts. The budget trims passages per document, not which documents surface. | **adopted** (env, all 3 `.env`) 2026-09-01 | lab A/B |
| `images` SearXNG category only at advanced depth | image engines (rate-limited or CAPTCHA'd) blocked ~+3.5 s per basic search; `search_ms` ~28 s → 8–16 s | **adopted** `2f65f758` 2026-09-01 | lab A/B |
| `MAX_ENRICH_URLS` 100 → 40 | 0 speedup: candidate pools are already ~36–43 pages, so the cap never binds; only a recall risk | **rejected** 2026-09-01 | lab A/B |
| Raise crawl4ai parallelism | Throughput peaks at 24–32 concurrent pages (2.21 pages/s) and **regresses** at 40 (1.72). Bound by single-thread render and remote tail latency, not RAM or shm. Ask already fans out up to 48. | **rejected**: don't raise | benchmark 2026-08-04 |
| Turn retrieval budget (deadline wrapper) | Did not close the 300 s failure (8/9 runs still failed). The model call is unbounded and dominates (~225 s of a 268 s step), and the deadline was not armed while parked at `yield`. | **reverted** `f0d146a6` 2026-07-28 | lab repro |
| Classifier `queryIsStandalone` token trim | Reverted the same day (`738244f9`, `5d7bdd8d`) | **reverted** 2026-07-24 | eval harness |

### D22. Multi-agent deep research

- **Status:** **shelved** (lab-only; code in `lib/agents/deep-research/`) · **Date:** 2026-08-04 · lab `095780b9`
- **Idea.** Onyx-style planner → parallel `balanced` sub-agents → a synthesiser that merges
  citations.
- **Evidence.** Clean n=3 blind-judge A/B (`scripts/eval/deep-research-ab/`). Ask's existing
  single-agent **`quality`** mode won on every dimension (depth, coverage, specificity, citation).
  It gathers 3–10× more sources (80–126 against 10–33). Multi-agent costs N× and did not earn its
  place. Two harness fairness bugs (narration in the collected answer, judge truncation) were found
  by reading raw outputs before trusting the verdict.
- **Consequences.** There is no `'deep-research'` `SearchMode`. User-facing "deep research" **is**
  `quality` (the `QUALITY MODE — DEEP RESEARCH PROTOCOL` prompt block).

::: danger Do not retry unless…
…sub-agents can gather at least as many sources as single-agent quality. The extra search *is*
the depth.
:::

### D42. Near-duplicate search skip only for true repeats

- **Status:** adopted · **Date:** 2026-10-01 (lab, staging and prod; deployed 10-01/02) ·
  **Commit:** `befe76fe` (lab `e57724a5`, staging `9249eec9`).
- **Context.** The search tool skipped a later search of the turn whose query embedding
  (Qwen3-Embedding-0.6B) had cosine ≥ 0.92 with an earlier query of the same search mode, and
  returned a "reuse those results" note instead.
  The point is to save a fan-out on a rephrasing whose results are already in context. The
  2026-09-29/30 quality A/Bs showed it skipping templated queries about different projects
  ([D40](#d40-quality-mode-read-pages-past-the-search-cap), findings). A review of the 76 skips
  stored in lab, staging and prod found 34 (45 %) that had dropped a real search: another
  product, model, version, source or facet (two different projects' "GitHub features" queries;
  a spec query against a price-and-warranty query). A dropped search is a hole in the answer; a
  repeated one costs one search round.
- **Evidence.** 446 real query pairs (a later query and an earlier query of the same turn, from
  lab, staging and prod) labelled blind by two independent annotators (kappa 0.916): 245
  repeats, 115 drill-downs, 86 different searches. A skip counts as correct only on a repeat.

  | Rule | Skips | Not repeats among them | Precision | Recall |
  |---|---|---|---|---|
  | cosine ≥ 0.92 alone (old) | 332 | 137 | 0.587 | 0.796 |
  | exact, or cosine ≥ 0.90 and the word check (new) | 61 | 0 | 1.000 | 0.249 |

  **Cosine alone cannot separate them.** The share of labelled pairs that are not repeats is
  11 % at cosine ≥ 0.97, 27 % at 0.95–0.97, 46 % at 0.93–0.95 and 67 % at 0.92–0.93: even the
  closest band holds one non-repeat in nine, so no threshold gives zero false skips. What does
  separate them is in the words: a templated query about something else names a different
  product, number, version, year, site or facet.
- **Decision.** Keep the skip and change what counts as a repeat
  (`findDuplicateQuery`, `lib/tools/search/query-dedup.ts:248-288`, wired at
  `lib/tools/search.ts:480-560`):
  1. **Exact:** equal once case, punctuation, quotes and spacing are ignored, word order kept.
     No embedding is needed, so this rule also works while the embedding service is down
     (before, an embedding failure switched dedup off for that search).
  2. **Near:** cosine ≥ `SEARCH_DEDUP_THRESHOLD` (now **0.90**) **and** the later query adds no
     content word (English stopwords removed, plurals folded; a short list of generic search
     words such as best, latest, review, explained, guide, official and vs may be added; facet
     words such as price, specs, features, benchmark and reddit deliberately may not; Han and
     kana text compared as character bigrams; versions and domains kept whole) **and** drops no
     number other than a year **and** does not reverse the word order around to, from, into,
     than, before, after or over.

  Dropping words is allowed (a restatement with fewer words is covered by the earlier results),
  so the cosine gate is what keeps a bare generalisation running. With the word check no
  labelled pair is wrongly skipped at 0.90 (nor at 0.89); 0.92 is kept for the old rule. The
  researcher's exact-repeat guard (`wrapSearchToolWithDedup`, lowercase and collapsed spaces)
  still runs first, unchanged. The rule depends only on the queries, not on the answering model
  ([D1](#d1-optimise-the-pipeline-not-the-answering-model)).
- **Rejected variant: a second tier of word swaps.** Also treating a query as a repeat when it
  swaps one or two ordinary words caught more repeats (recall 0.314, still no false skip) but
  was left out. Telling an ordinary word from a product name relies on capital letters, and
  models write product names in lowercase.
- **Trade-off.** About three in four true repeats now run, and each uses a search round (3 in
  speed and balanced, [D9](#d9-search-round-cap-enforced-inside-the-tool)). The rule prefers an
  extra round to a missing search.
- **Telemetry.** A skip line now ends with `(exact)` or `(near, cos=…)`. Every kept search whose
  cosine to an earlier query is ≥ 0.92 logs
  `[search-dedup] kept "<q>" — cos=… to "<earlier>" but adds: … | drops: … | reverses word order`
  (one of the three reasons), so every search the old rule would have skipped stays visible as
  tuning evidence ([telemetry](/operations/telemetry#the-lines)).
- **Side fixes.** A query is recorded even when its embedding failed, so an exact repeat is still
  caught. An empty or invalid `SEARCH_DEDUP_THRESHOLD` now falls back to the default
  (`resolveDedupThreshold`, `query-dedup.ts:74-82`); before, an empty value read as 0, which
  would have skipped nearly every later search in the mode.
- **Revert.** `SEARCH_DEDUP_TOKEN_GUARD=off` restores the old rule exactly (cosine ≥ threshold
  alone, default 0.92, no exact rule) on a container recreate; `SEARCH_DEDUP_ENABLED=off`
  disables the skip. Tests: `lib/tools/search/__tests__/query-dedup.test.ts` (the rule) and
  `lib/tools/__tests__/search-dedup.test.ts` (the tool's wiring). The labelled pair set is not
  in `scripts/eval/`.
- **Do not retry** a threshold-only rule, at any threshold, without a labelled pair set that
  shows zero false skips; the bands above say it will not.
- **Revisit if** `kept` lines show many searches kept for a generic word (extend
  `GENERIC_SEARCH_WORDS` with a test per word, never a facet word), or the share of true repeats
  that run costs measurable rounds on balanced turns.

### D45. Search withdrawn after the round cap, then answer-only steps

- **Status:** adopted (lab and staging; prod pending) · **Date:** 2026-10-07 · **Commits:** lab
  `d1a86bda` + `c86bbdaa` + `798030de`; staging `d799a91c` + `1f8ece82` + `49e33297`; prod
  pending.
- **Context.** The round cap ([D9](#d9-search-round-cap-enforced-inside-the-tool)) refuses a
  search with an ordinary tool result whose only stop signal is its notice, and `search` stayed
  in `activeTools` on every later step. Prod chat `cznh8gc1gz41vq2lwjb560br` (mistral-large-4,
  balanced, cap 3): 5 real searches, then 80 `search` calls refused over about 30 steps; 36
  steps, 89 tool calls, 2,066,500 prompt tokens, 259 s. The answer itself was fine (77
  citations, 0 unresolved). In stored history every other model stopped after 1–5 refusals (at
  most 5 in any turn, all envs), so the cap only stopped models that obey tool-result
  instructions.
- **Decision: three stages after the cap**, in `lib/agents/search-cap.ts`, applied in the
  researcher's `prepareStep` (`lib/agents/researcher.ts:1098-1135`) between the flow variant and
  the time deadline:
  1. **Stop offering `search`** (`withdrawSearchAfterCap`, `search-cap.ts:92-110`) from the step
     after the first result with `searchLimitReached: true`, filtering the variant's tool list if
     it set one, else the mode's. Every other tool stays offered.
  2. **Answer-only if `search` is called anyway** (`answerNowOnSearchEvasion`, `:150-163`): a
     `search` call on any step after the withdrawal (refused, failed input validation, or any
     other) makes every remaining step offer no tools and carry the answer deadline's
     `ANSWER_NOW_NOTE` (`answerNowOverrides`, factored out of `applyAnswerDeadline`,
     `lib/agents/answer-deadline.ts:80-95`; the note is added once), and the deadline's `execute`
     wrapper refuses any call the model still makes (`researcher.ts:966-979`). Every mode.
  3. **Answer-only after `POST_CAP_TOOL_STEPS_MAX` tool steps** (`answerNowAfterPostCapToolSteps`,
     `:233-252`; default 4, `:187`): only where `resolveFetchRoundsBudget(mode)` is null, i.e.
     the modes whose cap notice says "answer now" (speed and balanced by default). After that
     many tool-using steps past the capped step, the rest of the turn is answer-only, with the
     same override and refusal as stage 2.

  The time deadline stays last; `[deadline]` and its identity check (`o !== postCap`) still mean
  the 200 s deadline only. Both answer-only stages count as an answer step for the citation
  reminder (`researcher.ts:1175`). Each stage logs one `[search-cap]` line per turn
  ([telemetry](/operations/telemetry#the-lines)).
- **Evidence** (mistral-large-4, balanced; one lab turn after each stage, single runs):
  - **Stage 1 alone:** 36 → 9 steps, 2.07M → 0.40M prompt tokens, 259 → 163 s. But the model
    still called `search` on 4 later steps: 12 calls refused, 3 failed input validation (it
    guessed the arguments of a tool it no longer saw: `search_mode`, `recent`, `type`). A direct
    Ollama replay: offered only `fetch`, it emitted `search` calls anyway (1 of 2 runs); offered
    no tools plus the answer-now note, it answered (2 of 2). Hence stage 2.
  - **Stages 1–2:** `search` was withdrawn and not called again, but the model made 13 single
    `fetch` calls, one per step (several 404s on URLs it had constructed): 17 steps, 1.21M prompt
    tokens, 268 s. Balanced has no fetch budget, so nothing bounded that except the step ceiling
    and the 200 s deadline. Hence stage 3.
  - **Sizing stage 3** from stored history, tool-using steps after the cap in balanced turns:
    deepseek-v4.1-flash 0 in all 11 turns, glm-5.3-flash 0 in all 5, kimi-k2.6 0 in all 5,
    deepseek-v4-pro at most 1, the delisted deepseek-v4-flash p90 4 and max 6, mistral-large-4
    32, 13 and 5. Replayed, the three mistral turns switch at step 4 (stage 2) or 7; no stored
    turn of a currently listed model is affected; quality is unchanged.
  - **Stages 1–3:** the model answered on its own at step 4, after the withdrawal, before
    either answer-only stage fired: 5 steps, 13 tool calls, 221k prompt tokens, 162 s, 50
    citations, 0 unresolved.
- **Why stage 2 applies in every mode.** In stored history the one turn of a currently listed
  model it would have switched, a kimi-k2.6 quality turn on the lab (2026-09-30), made its stray
  `search` call while `search` was still offered, before stage 1 existed: not a model ignoring a
  withdrawal. Without stage 2, a quality turn that keeps calling a withdrawn `search` would be
  bounded only by the 200 s deadline.
- **Why stage 3 skips quality.** Quality's cap notice deliberately allows fetching pages this
  turn found, bounded by its fetch cap ([D40](#d40-quality-mode-read-pages-past-the-search-cap));
  there, tool steps after the cap are the point.
- **Not fixed here.** The budget was 3 but 5 searches ran: parallel calls in one step race the
  counter in `lib/tools/search.ts`
  ([known issue](/history/known-issues#parallel-search-calls-can-overshoot-the-round-cap)).
- **Tests.** `lib/agents/__tests__/search-cap.test.ts` (the pure stages),
  `researcher-search-cap.test.ts` (the real researcher loop with a model that keeps calling
  `search`), `answer-deadline.test.ts` (`answerNowOverrides`).
- **Revert.** No flag for stages 1–2: revert the commits. Stage 3 can be loosened with
  `POST_CAP_TOOL_STEPS_MAX` (a large value effectively disables it) on a container recreate.
- **Revisit if** a `… tool steps after the round cap` line shows up for a currently listed model
  on a turn that needed the extra reads (judge the answer first), or a model is seen ignoring
  the answer-only step itself (`[search-cap] refused <tool> call` lines).

---

## Knowledge, storage and config

### D23. Uploads and URL RAG on disk, not pgvector

- **Status:** adopted (as built) · **Dates:** 2026-07-07 (RAG pipeline) → 2026-09-12 (token budget)
- **As built.** Upload and pasted-URL chunks live in an on-disk **`.chunks.json` sidecar** next to
  the uploaded bytes (`lib/embeddings/upload-rag.ts`), with embeddings inline. They are ranked
  **in-process** at turn time (cosine + cross-encoder, top-K 10, full scan per turn). Only
  **recall** (`conversation_chunks`) and **memory** (`user_memories`) use pgvector(1024).
- **Why this is acceptable.** Attachments are per-chat and short-lived: the idle-chat TTL sweep is
  `UPLOAD_TTL_DAYS=14`. A persistent document library was never built (explicitly deferred).
- **Later hardening.**
  - `RAG_MIN_SCORE` relevance floor (default 0.01 on the cross-encoder scale; the cosine fallback
    fails open) (`8795e1b9`).
  - `budgetDocumentSources()` trims injected chunks to the real remaining context window, newest
    sources and best chunks first, so injected docs can no longer overflow the window and cause a
    provider 400 (`538dd138`, env `DOC_INJECT_MAX_TOKENS`, `0` disables).
  - The ingest wait is bounded (`INGEST_WAIT_TIMEOUT_MS`, `INGEST_WAIT_UNCLAIMED_MS`) with an
    ingestor heartbeat (`2f18355c`).
- **Revisit if** users need a persistent, cross-chat document library. That is the point to move
  chunks to pgvector (with RLS). See [RAG & uploads](/knowledge/rag-uploads).

### D24. The embedding model is data-locked

- **Status:** adopted · **Date:** 2026-07-19 (Qwen3 embedder introduced, `f3f23550`)
- **Decision.** `EMBEDDING_MODEL = Qwen/Qwen3-Embedding-0.6B` (1024-d, `remoteOnly`, GPU embedder
  on `.160:8788`) is **pinned**. Model refreshes (such as 2026-08-28) deliberately leave it alone.
- **Why.** Every vector in `conversation_chunks` and `user_memories` (`vector(1024)`) was produced
  by it. The dimension guard only checks the dimension, so **any other 1024-d model (such as
  mxbai-embed-large) passes silently and corrupts recall and memory with no error**. `remoteOnly`
  throws rather than falling back to a local approximation.
- **Evidence.** Verified 2026-08-09 and 2026-09-10. Prod vectors are provably Qwen3 (pre-flip rows
  have cosine 0.94–0.997 to Qwen3 against ~0.008 to mxbai) and identical across envs; no re-embed
  was needed.
- **Consequences.** Some stale comments and an error message still tell readers to set mxbai (see
  [known issues](/history/known-issues#stale-mxbai-embedding-hints-in-code)). **Never follow them.**
- **Revisit if** a better embedder is worth a full re-embed migration (backfill both tables, then
  flip, with recall off in between).

### D25. Signed upload URLs, shipped dormant

- **Status:** adopted (dormant) · **Date:** 2026-09-12 · **Commit:** `44e4599f`
- **Context.** `GET /uploads/[...path]` served any file with path-traversal protection only. The
  unguessable UUID path was the sole capability, with no expiry and no revocation. In anonymous
  mode the userId segment is a known constant.
- **Decision.** HMAC-signed, expiring capability URLs (`lib/storage/upload-url-signing.ts`,
  timing-safe). Bad signature → 403, expired → 410. The signature covers the `<userId>/`-prefixed
  object key, which binds the owner. The **stable key** is persisted, never a signed URL, and URLs
  are re-signed at render time in `loadChat` for file parts, generated images and document-citation
  cards. Old chats therefore get a fresh URL per view.
- **Why dormant.** Three knobs: `UPLOADS_URL_SECRET` (unset makes signing a no-op),
  `UPLOADS_REQUIRE_SIGNATURE` (default false) and `UPLOADS_URL_TTL_S` (3600). The deploy changed
  nothing; enforcement can be turned on later without breaking existing chats.

::: warning Enablement order matters
The guard is `requireSignature && signingConfigured`. Setting `UPLOADS_REQUIRE_SIGNATURE=true`
**without** a secret **fails open** and serves unsigned files. Set the secret first, test on lab,
then flip the flag. See [known issues](/history/known-issues#signed-upload-urls-not-enabled).
:::

### D26. Model Manager is the sanctioned `.env` editor

- **Status:** adopted · **Date:** 2026-07-17 (built); wiring fixed 2026-08-09 (`f45b96cc`, `49ffb638`); loopback bind `9b01367b`
- **What.** A separate Next.js app (`selfhosted/model-manager/` inside the repo, compose project
  `model-manager`, `127.0.0.1:3939`, password-gated). It edits prod's `.env` with automatic
  backups, recreates `ask`, and manages the reranker over SSH.
- **Decision.** Env config changes for prod (model roster `OLLAMA_MODELS`, `SEARCH_*` knobs and so
  on) go through its `/api/apply`, not hand edits. `apply` runs the **exact** prod deploy command:
  `docker compose -p ask-stack -f <base> -f <vpn overlay> up -d --force-recreate --no-deps ask`,
  with a `--wait` health gate.
- **Why (the footgun it replaced).** It used to run `docker compose -f <base> up -d ask` from the
  staging worktree, with no `-p`, no overlay and no `--force-recreate`. Because the base compose is
  `name: ask-stack` (prod), every "apply" **recreated prod from staging's `.env`**, and without
  `--force-recreate` `.env` edits never took effect.
- **Consequences.** It is effectively root on the host (repo RW, docker socket, SSH key), so it is
  bound to loopback; reach it with `ssh -L 3939:localhost:3939`. It now re-verifies the session
  inside the `/api/apply` handler (`ac437a2b`). Because it writes prod's `.env` as root, every
  write must keep the file's owner and mode; until 2026-09-25 it did not, and left prod's file
  `root:root 0644` ([known issues](/history/known-issues#prod-env-left-root-root-0644)). Some
  newer knobs (for example the `UPLOADS_*` ones) may not yet be in its env schema *(unverified)*.
- **Revisit if** staging/lab need the same UI. It manages prod only.

### D27. Saved model pick outranks the default

- **Status:** adopted (intentional) · **Date:** 2026-07-23 (`c1016bdd`); confirmed in the 2026-08-09 audit (M7 not changed)
- **Behaviour.** Logged-in users' `user_settings.preferred_chat_model` and guests' `selectedModel`
  cookie outrank `DEFAULT_CHAT_MODEL` **forever**. `lib/utils/model-selection.ts` checks only that
  the provider is enabled, so a **delisted** model keeps being sent. The picker may display a
  fallback while the stale id is used.
- **Why kept.** "Delisting doesn't migrate anyone" was a deliberate choice. The 2026-08-09 audit
  called it split-brain (M7), and it was left alone on purpose.
- **Consequences.** To see which model actually answered, read `modelId` in the `[latency]` line.
  To move users, clear the column and the cookie. Before making any cloud model the default, send
  one real generation through it: `/api/show` resolving does not prove it is usable (kimi-k3
  returned HTTP 402 on an empty extra-usage balance in July; it worked again by 2026-09-11).

---

## Client state and UX

### D28. Sidebar refresh invariants and uncached conversation reads

- **Status:** adopted · **Commits:** `7516dce7` (optimistic reorder, 2026-09-10), `fb63e618`
  (09-19), `eb461c8d` (09-21), `eb8de320` (09-22); uncached history read `3e39181d` (2026-07-16)
- **Context.** A new chat starts at `/`. After the first send, `chat.tsx` calls
  `history.pushState` to `/search/<id>` while the real Next route stays `/`. The row is only
  persisted at the stream's `onFinish`, seconds later. Meanwhile the sidebar re-sorted "Recent"
  with a debounced `router.refresh()`. Three bugs followed in a row:
  - **404 flash** (09-19): a refresh 400 ms after the new-chat `chat-bump` re-resolved the fake
    `/search/<id>` before the row existed → `notFound()`.
  - **UI blanks mid-stream** (09-21): a follow-up's refresh re-fetched the RSC, which lacks the
    still-generating, unpersisted assistant message.
  - **First answer vanishes** (09-22, **critical**, introduced by the 09-21 fix): the `onFinish`
    refresh remounted the pushState'd chat on its real route. That route read `loadChat()` through
    `unstable_cache`, whose tag is revalidated with the `'max'` profile, i.e.
    stale-while-revalidate, so it served the previous snapshot.
- **Invariants (do not break):**
  1. **Never `router.refresh()` while any chat is streaming.** `lib/streaming/stream-activity.ts`
     lets the sidebar defer refreshes until nothing streams.
  2. **Never refresh a pushState'd home-started chat.** Its `onFinish` sends an optimistic
     `chat-bump {title, isNew}` instead.
  3. `chat-bump` drives only the client-side optimistic reorder
     (`components/sidebar/recent-optimistic.ts`, a max-merge on `lastViewedAt`). It is **not** in
     `REFRESH_EVENTS` (`components/app-sidebar.tsx:79` = `chat-history-updated`,
     `current-chat-deleted`).
  4. **Conversation views and history reads use `loadChatUncached`.** That covers
     `app/search/[id]/page.tsx`, the streaming path and `GET /api/chat/[chatId]/messages`. Cached
     `loadChat` is for metadata only. A stale read causes the "answers my previous question again"
     bug.
- **Revisit if** chat creation moves server-side (a real route before the first send). Then
  pushState, and invariant 2 with it, can go. See [client state](/request-lifecycle/client-state).

### D29. Stop keeps the partial answer

- **Status:** adopted · **Date:** 2026-09-22 · **Commit:** `554a4921` (lab `e79e7b5c`)
- **Decision.** Aborts carry a reason (user Stop vs superseded; a client disconnect never aborts an
  authed turn). On user Stop the partial is sanitised (`sanitize-stopped-message.ts`: keep only
  finished tool parts, set `metadata.stopped=true`) and saved. A newer-turn guard
  (`latest-message-id.ts`) skips the save if a newer turn has started. A new turn waits (bounded)
  for a pending stop-save, which keeps history ordered. Timeout aborts still discard.
- **Why.** Discarding the partial made a follow-up re-answer the previous question.
- **Consequences.** A finished stream is **not** replayable. A late returner gets 204 and reloads
  the persisted conversation. `metadata.stopped` is rendered as a muted "Stopped" pill in the
  answer's action row since 2026-09-24, live and after a reload (see
  [known issues](/history/known-issues#stopped-label-not-rendered)).

### D30. degoog: public instance kept, per-env scrapers disabled

- **Status:** adopted · **Dates:** 2026-08-01 (incident), 2026-09-07 (`0347cdb2`, `ae81f4a9`)
- **Context.** There are four degoog stacks. `:4444` on `.231` is the **public / personal**
  instance, used directly by people. The per-env ones are prod `:4445`, staging `:4446` and lab
  `:4447`. On 2026-08-01 `:4444` was stopped as "orphaned" because no container env referenced it.
  It was in use.
- **Decisions.**
  1. **Never decommission a service with a published port because no container references it.**
     Container-env greps cannot see browsers, bookmarks or external clients. Check real traffic
     (`ss -tn` peers over time, access logs) or ask the owner.
  2. Per-env degoog was moved to `.17` and **disabled** (`DEGOOG_ENABLED: 'false'`, hard-coded in
     the tracked `docker-compose.yaml:61`, so it must be committed). degoog is quality-only and the
     slowest source (~13 s); quality falls back to SearXNG plus the APIs.
- **Revisit if** quality mode lacks coverage. Re-enable per env: bring up `degoog-<env>`, set
  `DEGOOG_ENABLED=true` in that env's compose, then rebuild or recreate.

### D31. Hands-free voice conversation loop

- **Status:** **reverted** (lab-only; never shipped) · **Date:** 2026-08-22 · **Commit:** lab `b0ff56ad`
- **What.** Voice "Slice 3": a VAD-driven loop (speak → auto-submit → hear the answer → re-arm the
  mic). It was built in 14 commits (`746204ca..a10cbf0f`) and worked end to end with a real mic.
- **Why removed.** The per-turn read-back latency (VAD endpoint → Whisper → answer → TTS) made it
  **cumbersome**. STT was already optimal; the lag was the cumulative pipeline. Tap-to-dictate and
  read-aloud were kept.
- **Gotchas preserved for a revival:** `@ricky0123/vad-web@0.0.30` needs `onnxruntime-web@1.22.0`
  **exactly** (vendor its `.mjs` glue and `.wasm` under `public/vad/`). `speak()` must resolve on
  `onended`, not `play()`, or the loop hears itself. Gate the detector on `visibilitychange`.
  `getUserMedia` needs a secure context.

::: danger Do not retry unless…
…you build a **streaming** voice pipeline (streaming STT/TTS, barge-in). Re-applying the
turn-based loop (`git revert b0ff56ad`) brings back the same latency.
:::

### D32. Homepage and mobile layout

- **Status:** adopted · **Dates:** 2026-08-20 → 2026-09-22
- **Decisions.**
  - **Cosmic "Orbit" homepage** (`8e0c1873`): a three-body canvas field, auto-cycling headline,
    glass composer, Hanken Grotesk / Instrument Serif, a Discover briefing row, and sidebar weather
    with worldwide location search. The composer is wide on the homepage only; the dark theme was
    retinted globally.
  - **Mobile empty state** (`303d7a0d`): the empty-state container is
    `justify-start overflow-y-auto md:justify-center`. On phones it top-aligns **and scrolls**. The
    root cause was a non-scrolling `justify-center` flex container one level above the hero; a tall
    Discover column overflowed it and pushed the composer off the top.
  - **Hero stays centred** on all breakpoints (`8d33b149`). Two earlier "shorter / top-aligned
    hero" fixes (`671145de` and a `46vh` attempt) treated the wrong element and were superseded.
  - **While the composer is focused on mobile** the hero switches to `justify-start pt-6`
    (`41f8ed8e`). The on-screen keyboard plus textarea autosize otherwise re-centres the block and
    pushes the caret out of view. Fallback if it still drifts: pin the composer to the bottom.
  - Mobile composer row: voice read-aloud and settings sit behind a `⋯` menu (`2f61714f`); the mic
    stays inline (its press-and-hold gesture can't live in a popover). The left group doesn't
    shrink, the right group absorbs, and the model pill becomes icon-only when crowded
    (`ed6f4b35`).
  - The mobile sidebar weather is a one-line tap-to-expand (284 → 39 px, `688846c4`). Sidebar times
    render in the viewer's timezone after hydration.
- **Lesson.** For "content pushed off-screen", inspect the **scroll/overflow container**, not only
  the element. Verify phone layouts with real mobile emulation (Playwright), not a resized desktop
  window. See [frontend](/request-lifecycle/frontend) and [testing](/operations/testing-qa).
- **Also.** `Permissions-Policy` must keep `microphone=(self), geolocation=(self)` in
  `next.config.mjs`. A hardening pass set them to `()`, which silently broke dictation (`9437d212`)
  and the weather widget (`40eb0e86`).

### D33. Prod rate-limiters left inert

- **Status:** adopted (declined fix) · **Date:** 2026-08-11
- **Context.** The 2026-08-09 audit (M10) found prod's rate-limiters inert.
- **Decision.** The owner chose to keep prod unlimited. Guest chat is off, metered search APIs are
  budget-capped and fail closed, and only the Ollama balance and GPU/crawl are unbounded, which is
  acceptable for a trusted user base. Don't re-raise it without a change in audience.

## Recall and fleet

### D34. Recall rerank deferred, not aborted

- **Status:** adopted · **Date:** 2026-09-23 · **Commit:** `d0585bf8` (lab `f87b6d3d`); Model
  Manager field `32e0b1d0`
- **Context.** Prod telemetry showed `recall_budget_hit=true` on 31 of 46 turns (true
  `recall_ms` about 5.5 s against the 1.5 s `RECALL_BUDGET_MS` of D8); lab was 121 of 172. So
  past-conversation context almost never reached the answer. Stage timings on real prod history
  (40 real user queries, read-only) put nearly all of the cost in the cross-encoder: query embed
  p50 45 ms, both DB arms about 12 ms, rerank of 20 passages × 512 tokens **p50 3.4 s**. The live
  reranker is Qwen3-Reranker-8B, whose cost is linear in passages × tokens (about 160 ms per
  512-token passage). A second cause was self-contention: the speculative recall started on the
  raw message ran the **full** rerank, and on `refetch` turns (the classifier rewrote the query)
  that discarded rerank was still on the GPU when the real one arrived. Replaying that pattern
  (second request 1.5 s after the first) took the refetch rerank from 3.3 s alone to 5.0 s.
- **Decision.**
  1. **Defer the rerank instead of aborting it.** The speculative phase
     (`prefetchRecallCandidates`, `lib/memory/recall-inject.ts:74`) now runs only the embed and the
     two DB arms. The rerank runs **once**, after `chooseRecall`, on the query the turn will
     actually use; `gated` turns never rerank.
  2. **Pool 10 passages at 384 tokens.** `RECALL_RERANK_POOL` default 20 → **10** and a new
     `RECALL_RERANK_MAX_LENGTH` (default **384**, previously a hardcoded 512)
     (`lib/memory/recall-search.ts:28-42`). Both are env knobs; the length is editable in Model
     Manager.
- **Why not abort the speculative rerank.** Cancelling on the client does not free the GPU.
  Aborting the HTTP call (the mechanism `crossEncoderScore` already uses for its timeout,
  `lib/utils/cross-encoder.ts:34`) only closes the connection: the reranker's `POST /rerank` is a
  synchronous FastAPI handler (`/home/nightfury/selfhosted/reranker-qwen/app.py`, `def rerank`)
  that runs every forward-pass batch to completion without checking for a client disconnect. An
  aborted request therefore keeps the 2080 Ti busy exactly as long as a finished one, and the next
  rerank still queues behind it. The only way to avoid the contention is not to send the
  speculative rerank at all. The embed and DB arms are cheap (under 60 ms), so prefetching just
  those keeps most of the overlap with the classifier.
- **Why 10 × 384 and not 20 × 256.** Both roughly halve the tokens scored. On the same 40
  queries, **10 × 384** (p50 **1.3 s**) injected on the same 14 turns as 20 × 512 (25 vs 26 hits),
  picked the identical injected set on **35 of 40** and the same top hit on 36 of 40; the
  differences swap between near-equally relevant chunks of the same thread. **20 × 256** matched
  the injected set on only **31 of 40**: truncating each passage hurt more than scoring fewer
  passages. A pool of 8 (about 1.0 s) kept the same top hit on 37 of 40 but with 23 vs 26 hits.
- **Evidence after.** Lab, browser, 5 non-gated turns: `recall_ms` 439–1489 ms (p50 about
  1.3 s), 0 budget hits, and a `data-recall` chip on a turn that asked about an earlier chat. No
  vector index was needed: an exact scan plus top-N sort takes about 12 ms at this size and avoids
  HNSW's filtered-search recall loss.
- **Consequences.** The margin under 1.5 s is thin; a concurrent web-search rerank on the same GPU
  can push single turns over. Details: [memory & recall → recall latency](/knowledge/memory-recall#recall-latency).
- **Revisit if** the reranker model changes (re-measure the per-passage cost). Don't reintroduce a
  speculative rerank unless the reranker service learns to cancel work on disconnect.
- **Addendum 2026-09-25: pool 8 on prod and lab.** The thin margin showed on prod: one 5-turn
  chat at pool 10 had `recall_ms` 1375–2076 ms and 3 of 5 budget hits. A bench on 2026-09-24
  timed the refetch path (query embed + both DB arms + rerank at 384 tokens) on 40 real prod
  queries, 80 samples per pool size:

  | Pool | p50 | p90 | max | Samples over 1.2 s |
  |---|---|---|---|---|
  | 10 | 1365 ms | 1400 ms | 1452 ms | 63 of 80 |
  | 8 | 1088 ms | 1114 ms | 1138 ms | 0 of 80 |

  Pool 8 injected exactly the same set as pool 10 on **40 of 40** queries, with the same top hit.
  (The 2026-09-23 note above, "23 vs 26 hits" at pool 8, came from an earlier run whose
  configuration is not recorded; the 2026-09-24 bench is the direct comparison.) **Decision:**
  run `RECALL_RERANK_POOL=8` where recall matters most, without changing the code default (10):
  prod sets it in `ask-prod/.env` (applied through the Model Manager), the lab in
  `docker-compose.lab.yaml` (lab `8b6103e9`); staging keeps the default. A 4-turn prod chat
  afterwards had `recall_ms` 1080–1342 ms, 0 of 4 budget hits, and recall injected on all 4.
  **Limit found in the same bench:** with a search-sized rerank already running on the shared
  reranker, recall missed the 1.5 s budget in 11 of 12 trials at either pool size. The GPU
  interleaves the two requests, so no pool size fixes that; it is tracked as
  [a known issue](/history/known-issues#recall-misses-the-budget-under-rerank-contention).
  **Don't** shrink the pool further to chase those misses. Revisit the pool only with a new
  quality comparison on real queries, and the budget only if time-to-first-token can afford
  it.

### D35. Retire and remove the .231 Ask stacks

- **Status:** adopted · **Date:** 2026-08-27 (retired) → 2026-09-23 (containers removed) →
  2026-09-24 (volumes, images and checkouts deleted)
- **Context.** The app stacks moved from MiniNightFury (.231) to NightFuryX (.17) on 2026-08-23.
  The .231 copies were retired on 2026-08-27/28 and their DB and upload volumes archived to
  `.17:/home/nightfury/backups/ask-231-retire-2026-08-28/`, but containers, volumes and checkouts
  were left in place as a rollback net. At .231's 2026-09-16 boot an outdated
  `~/ask-fleet-boot.sh` recreated all three stacks, because `fleet-boot/deploy.sh` never synced
  .231. They ran unnoticed until 2026-09-22 with stale code and a stale copy of user data, plus
  legacy cron jobs (upload expiry, Mullvad rotation) aimed at them.
- **Decision.** Remove every Ask app artefact from .231 and bring .231 under the same
  deployment path as the other hosts:
  - 2026-09-23: all 16 containers and the three `_default` networks removed; `deploy.sh` syncs
    .231; its boot case reconciles only `crawl4ai` and `flaresolverr`; the crontab keeps only
    host maintenance, the crawl4ai watchdog and `~/fleet-boot/rotate-daily.sh public-searxng
    degoog`; the weekly `fleet-update-public-search.timer` runs from `~/fleet-boot`.
  - 2026-09-24 (UTC; the evening of 09-23 local time): the kept volumes, the stacks' images and
    the old `ask`, `ask-prod` and `ask-flow` checkouts were deleted. The 42 commits that existed only in .231's lab checkout were saved
    first as local branches on .17 (`archive/231-flow-design-pipeline`,
    `archive/231-wip-context-latency-budget`).
- **What stays on .231, and why.** `crawl4ai` (single-thread speed, see
  [fleet](/infrastructure/fleet#why-each-job-lives-where-it-does)), FlareSolverr (now published
  on the LAN for every env), the public SearXNG `:8127` (the prod/staging SearXNG fallback) and
  public degoog `:4444` (human users, see [D30](#d30-degoog-public-instance-kept-per-env-scrapers-disabled)),
  and the host `cloudflared` for the owner's other sites.
- **Why remove rather than keep a rollback net.** The "net" had already come back to life once
  and served nothing but confusion (same container names and ports as the real stacks). Rollback
  lives in git on .17 and in the August volume archive, not in a second running copy.
- **Revisit if** Ask ever needs a second app host. Build it through `deploy.sh` and
  `ask-fleet-boot.sh` from the start, never from a hand-kept copy.

### D41. On WSL hosts, nothing that waits for Docker is enabled at boot

- **Status:** adopted · **Date:** 2026-09-29 · **Commits:** prod `bbf936f8` (lab `8d59d2f1`;
  staging `d0fdba20`)
- **Context.** Since 2026-09-23 `fleet-boot/deploy.sh` enabled `ask-fleet-boot.service`
  (`WantedBy=multi-user.target`, `After=docker.service`) on every host. On WSL hosts Docker
  Desktop injects its WSL integration (`/var/run/docker.sock`) only **after** systemd reports
  that boot has finished. The oneshot's `wait_docker` polls for
  Docker for up to 120 s, so the boot waited for a Docker that was waiting for the boot. On
  2026-09-29 Serenity (.171) rebooted and hung: `systemctl` reported "Bootup is not yet
  finished" for about 8 minutes, and Docker Desktop's `backend.sock` never appeared.
- **Decision.** `deploy.sh` decides per **platform**, not per IP
  (`fleet-boot/deploy.sh:44-53`): when `systemd-detect-virt --container` prints `wsl` it
  leaves the unit **disabled**; otherwise (bare metal, .231) it enables it. On the WSL hosts
  (.17, .160, .171) the unit still runs on every boot: the `lan_automation`
  `fleet-boot.timer` (`OnBootSec=75s`) starts `fleet-boot.service`, which `Wants=` and
  `After=` `ask-fleet-boot.service`, so it runs after boot has finished. **Rule:** on a WSL
  host, nothing that waits for Docker may be enabled into `multi-user.target`.
- **Evidence.** The same deadlock was measured on Serenity on 2026-08-29 for the
  `lan_automation` unit (5 min 10 s boot with it enabled, 2.0 s without), which is why that
  unit already ran from a timer. Recovery on 2026-09-29: `wsl --shutdown` and a Docker Desktop
  restart from Windows; with the unit disabled, `systemd-analyze` on .171 reports userspace
  boot in 1.6 s. Checked 2026-09-30: `systemctl is-enabled ask-fleet-boot.service` is
  `disabled` on .17, .160 and .171 and `enabled` on .231, and on the WSL hosts
  `systemctl show ask-fleet-boot.service -p WantedBy` lists only `fleet-boot.service`.
- **Consequences.** On WSL hosts the boot reconcile starts about 75 s after boot instead of
  during it, and it depends on `fleet-boot.timer` from the separate `lan_automation`
  repository staying enabled. .231 has no `fleet-boot.timer`; its unit is enabled directly.
- **Do not retry** enabling `ask-fleet-boot` (or any new Docker-waiting unit) into
  `multi-user.target` on a WSL host, whatever `After=`/`TimeoutStartSec=` it carries. Recovery:
  [runbook](/operations/runbooks#wsl-host-hangs-at-boot).

## Citations

### D36. Strip historical citation anchors; resolve citations per turn only

- **Status:** adopted · **Date:** 2026-09-24 *(lab; staging and prod by port)*
- **Context.** About one prod turn in five had citation anchors that named no tool call of that
  turn (`citations_unresolved`). The renderer scopes citation maps **per message**, so such
  anchors render as nothing. A replay of prod history classified the unresolved anchors. The
  largest class (146 of 655 over all history; 70 of 158 in the 11 flagged recent turns) was
  anchors copied from **earlier answers**. The model-bound history still carried every earlier
  answer's `[N](#<old toolCallId>)` text, while `pruneMessages` (`toolCalls:
  'before-last-2-messages'`, `lib/streaming/create-chat-stream-response.ts:460-463`) had already
  removed those turns' tool calls and results. Follow-up turns that ran no search had every
  anchor unresolved.
- **Decision.**
  1. Remove citation anchors from **prior** assistant turns in the history sent to the model
     (`stripCitationAnchorsFromHistory`,
     `lib/streaming/helpers/strip-citation-anchors-from-history.ts`, applied in both the chat and
     the ephemeral stream paths). The trailing assistant message is left alone, since it is the
     turn being continued. Stored and displayed answers keep their anchors.
  2. Keep citation resolution **per turn**. An anchor that names an earlier turn's tool call is
     not looked up in that turn's results. It is dropped, unless the URL-fragment rule
     (`resolveByUrlFragment`) matches exactly one of the current message's own sources.
- **Why not resolve across turns.** A conversation-wide citation map was the original design and
  was removed on purpose: it let an anchor carried over from an earlier turn resolve cleanly to
  the **wrong** source (measured: 120 of 2,975 anchors in prod history, see
  [frontend › Citations](/request-lifecycle/frontend#citations)). A missing citation is visible
  and harmless; a confidently wrong one is not. Removing the dead ids from the model's context
  fixes the cause instead of widening the lookup.
- **Why stripping is safe.** The anchors carry no information the model can use: their tool
  results are already pruned, so they point at nothing. The prose of earlier answers is kept.
- **Evidence.** Resolver replay on prod history: unresolved 16.6 % → 14.5 % (all history),
  7.1 % → 5.2 % (last 45 days). The history strip and the fetch `toolCallId` fix are preventive
  and can only be measured on live turns; watch `citations_unresolved`. See
  [known issues › Unresolved citations](/history/known-issues#unresolved-citations).
- **Revisit if** live turns still show copied old ids after the port (the strip regex
  `[N](#id)` would then be missing a format), or if per-turn scoping is ever replaced by a
  citation store that is stable across turns.
- **Addendum 2026-09-26: one resolver; N is the position within that call.** Lab `dbbbc376`
  (cherry-picked to `dev` as `0bd8f8cc`, staging `7af2beff`).
  - **Context.** Three places decided whether an anchor resolved, each with its own rules:
    `processCitations` (rendering), `auditCitations` (the `[latency]` counters) and
    `extractCitedSourceUrls` (`[cite-urls]`). The audit only checked that an anchor's id belonged
    to the turn, so a real id with an out-of-range number counted as resolved while rendering
    nothing; on a 60-day replay the audit agreed with rendering on 333 of 374 messages. The
    prompts also taught two numbering schemes (the speed prompt: one number per toolCallId,
    assigned sequentially; the balanced prompt: result order within each search) and used
    `<id-A>`-style placeholders that models copied verbatim.
  - **Decision 1: a single resolver.** `resolveCitationAnchor` (`lib/utils/citation.ts:376-411`)
    is the only place an anchor is resolved, and all three callers use it, so the counter
    reports exactly what the reader sees. It returns `own`, `recovered` (with the repair used)
    or `unresolved`. Lookup order: the id as written (after the `toolu_`/`call_`/`search-`
    prefix normalisation); the id unwrapped from `<id-…>` / `<…>` / `id-…`
    (`unwrapTemplateId`, `:148-154`); a placeholder (`isPlaceholderAnchorId`, `:128-139`),
    resolved only when the message made exactly one citable call; the URL-fragment rule from
    2026-09-24. Within a call, an in-range N is that result; an out-of-range N resolves only on
    a fetch whose output holds exactly one page that is not a `Fetch failed:` result
    (`resolveWithinCall`, `:317-351`). Since 2026-10-06 (lab, staging and prod) two
    more steps sit between the unwrap and the placeholder: a shortened id (`id-prefix`) and a
    full-length id one character off (`id-typo`), each only when it names exactly one call of
    the message ([D44](#d44-shortened-and-one-character-off-citation-ids-resolve)).
  - **Decision 2: N is the 1-based position of the result within that tool call's `results`,
    restarting at 1 for every call.** It is what `extractCitationMaps` always built
    (`results[N-1]`, `lib/utils/citation.ts:531-536`), so the prompts were changed to match the
    renderer, not the other way round. One shared `getCitationFormatGuidance()`
    (`lib/agents/prompts/search-mode-prompts.ts:107-124`) states it for speed and balanced (and
    so quality), including "a one-page fetch is always [1]" and a running count shown as WRONG.
    Since 2026-09-27 that counting text is used only with `CITATION_HANDLES=off`; by default the
    model copies a ready-made citation instead ([D38](#d38-ready-made-citation-handles)).
  - **Decision 3: the worked-example ids live in `citation.ts`.** `PROMPT_EXAMPLE_SEARCH_ID` and
    `PROMPT_EXAMPLE_FETCH_ID` (`lib/utils/citation.ts:92-93`) are defined next to the resolver
    and imported by the prompt module, and `PLACEHOLDER_ANCHOR_IDS` (`:101-119`) lists every
    example id the prompts have ever shown. A model that copies an example is then recognised
    rather than treated as an invented id. They are defined there, not in the prompt module,
    so the client bundle does not import the prompts. Realistic UUIDs replaced `<id-A>` because
    a model copies the **shape** of an example: the lab showed `<id-A>` copied literally and
    also wrapped around correct ids.
  - **Decision 4: a multi-result call with a wrong number stays dropped.** A search, or a fetch
    that returned several pages, has many candidate sources; an out-of-range number does not
    say which one was meant, so any choice would be a guess. Only a one-page fetch is
    unambiguous. Likewise a placeholder in a turn with two or more citable calls stays dropped.
    Per-turn scoping (point 2 of the original decision) is unchanged: no repair ever looks at
    another message's calls.
  - **How the fetch rule knows the tool type.** `extractCitationMaps` records each map's part
    type in a module-level `WeakMap` keyed by the map object (`CITATION_MAP_TOOL_TYPE`,
    `lib/utils/citation.ts:163`, set at `:541`), so the `Record<toolCallId, Record<N, item>>`
    shape every component passes around did not change. A map that is copied or built by hand
    has no entry, and the fetch rule silently does not apply to it: pass the maps through by
    reference.
  - **Evidence** (replay of 60 days of stored answers through the old and new resolver). Visible
    citations: prod 1,460 → 1,470, lab 3,880 → 3,925; 0 lost, 0 rendered links changed; audit
    agrees with rendering on 374 of 374 messages. In-range running-count numbers (a real,
    different result of the same search) cannot be repaired and remain open
    ([known issue](/history/known-issues#running-count-citation-numbers-can-point-at-the-wrong-result)).
  - **How to change the examples.** Keep every example id in `citation.ts`. When an example id
    is retired, leave it in `PLACEHOLDER_ANCHOR_IDS` so answers that copied it keep being
    recognised. `lib/agents/prompts/__tests__/search-mode-prompts.test.ts` fails if a prompt
    shows a placeholder or retired id, states a second numbering scheme, or has a non-WRONG
    example anchor that would not render.
  - **Revisit if** judged live answers still show running-count numbers after the unified
    prompt; the next lever is numbering results explicitly in the tool output the model sees
    (needs a lab A/B). **Done 2026-09-27:** the prompt rule alone kept failing on the lab, and
    every citable result now carries its finished citation
    ([D38](#d38-ready-made-citation-handles)). The within-call rule above is still what the
    resolver does; it is no longer something the model has to apply.

### D38. Ready-made citation handles

- **Status:** adopted · **Date:** 2026-09-27 (lab, staging and prod the same day) ·
  **Commits:** `8878a42d` (lab `48cc3938`, staging `696bd454`); the reload fix below `0ca166fe`
  (lab `8a67e3cd`, staging `3402bc5d`); the Model Manager switch `337dbee7` (lab `1194ae0f`,
  staging `2c41c22c`).
- **Context.** Since the D36 addendum the renderer and the prompts agree that `[N](#id)` means
  result N (1-based) of tool call `id`. The model still had to work N out: each call's results
  reached it as a bare JSON array, and many models numbered sources as a running count across
  the answer instead. An in-range running-count number renders a real, different page, and no
  counter can see it. The unified prompt rule of 2026-09-26, with its worked example, was still
  a counting task and kept failing on the lab (11 of 19 citations in one turn). On a 60-day
  replay, 22 of 88 prod answers showed the pattern and about 459 prod anchors likely pointed at
  the wrong page
  ([known issue](/history/known-issues#running-count-citation-numbers-can-point-at-the-wrong-result)).
- **Decision.** Hand the model the finished citation and tell it to copy it.
  1. **The handle.** `addCitationHandles` (`lib/utils/citation-handles.ts:62-90`) returns a copy
     of a tool output in which each result carries `cite: "[N](#<toolCallId>)"` as its first key.
     N is the result's 1-based position in **that output's** `results`, the same array
     `extractCitationMaps` indexes, so a copied handle resolves to the result it sits on.
     Positions count every result, including ones that get no handle. No handle is given to a
     result that would not render when cited (invalid URL, position above
     `MAX_CITATION_NUMBER` = 100) or to a `Fetch failed:` placeholder (`isCitableResult`,
     `lib/utils/citation.ts:180-185`), nor when the id contains whitespace or parentheses and so
     would not survive the anchor regexes (`ANCHOR_SAFE_ID_RE`, `citation-handles.ts:42`). A
     legacy output with a `citationMap` is left alone, and the input is never mutated.
  2. **Where it is added: only in model-facing output.** The `search` tool's `toModelOutput`
     (`lib/tools/search.ts:1328-1341`) numbers the results **after** the researcher's per-turn
     URL dedup, because the dedup wrapper yields the trimmed list and keeps the tool's
     `toModelOutput` (`lib/agents/researcher.ts:280-377`). `fetch` gained a `toModelOutput`
     (`lib/tools/fetch.ts:800-806`) that numbers the merged `results`, from which failed URLs
     are already left out; with the flag off it returns exactly what the SDK sends for a tool
     without one. Attached-document and pasted-URL excerpts never pass through a tool, so
     `buildDocumentRetrievalModelMessages` adds the handles itself
     (`lib/streaming/helpers/document-retrieval-part.ts:226-231`): excerpt k gets
     `[k](#<sourceId>)`, which resolves to the part's `#chunk-k` result. AI SDK 6 passes
     `{ toolCallId, input, output }` to `toModelOutput`
     (`node_modules/@ai-sdk/provider-utils/dist/index.d.ts:1134-1147`), and that `toolCallId`
     is the id the UI part and persistence store, including for the forced step-0 search.
  3. **Never stored, so it cannot leak across turns.** The UI part, the database and the
     browser get the raw output. Chat history is converted without `tools`
     (`convertToModelMessages`, `lib/streaming/create-chat-stream-response.ts:455-457`), so
     `toModelOutput` does not run on replayed tool results and an earlier turn's results carry
     no handle. Earlier answers' anchors are still stripped from history (D36).
  4. **Prompts: copy, never compute.** With the flag on, `getCitationFormatGuidance()`
     (`lib/agents/prompts/search-mode-prompts.ts:107-124`) says to copy a result's `cite` string
     exactly, never to compute, renumber or edit a citation, and that a result without `cite`
     cannot be cited. The counting rule and the worked example are gone from the on text. The
     same switch rewrites the numbering sentence of the balanced/quality citation rule
     (`getCitationNumberingSentence`, `:276-280`), the forced-search addendum's citing sentence
     (`getForcedSearchPromptAddendum`, `lib/agents/always-search.ts:330-338`) and the
     attached-sources clause (`lib/agents/researcher.ts:899-909`). The speed prompt is now built
     per turn (`getQuickModePrompt()`, `researcher.ts:753`) instead of from the module-level
     `SPEED_MODE_PROMPT` constant, so the flag is honoured there too.
  5. **The flag.** `CITATION_HANDLES`, read per call by `isCitationHandlesEnabled`
     (`citation-handles.ts:24-28`). Default on; only the literal `off` disables it (the
     `ALWAYS_SEARCH` / `RECALL_ENABLED` convention). Off restores the previous model-facing tool
     output and prompt text byte for byte. The tool-output tests below pin the off output
     exactly; the prompt tests check the key sentences of both texts.
- **Cost.** A handle adds about 52 characters (about 29 tokens) per result: about +783 tokens on
  a 27-result search. The on prompt is shorter (1,065 characters less for balanced and quality,
  965 for speed; about 400 tokens), so a balanced call nets about +370 tokens.
- **Evidence (lab A/B, 2026-09-27).** One build (the same image), arms switched by env
  (`docker-compose.lab.yaml` passes `CITATION_HANDLES` through from the shell). 4 multi-source
  first-turn questions × 2 models per arm. A blind support judge (`deepseek-v4-pro:cloud`) read
  each claim, the sentence before it and the stored source text; 16+ judgements were checked by
  hand; a pairwise answer judge ran both orderings ([D4](#d4-judge-answers-not-source-counts)
  method). The harness is not committed to `scripts/eval/`.
  - Unsupported (wrong-page) citations: deepseek-v4.1-flash **64.0 % → 11.0 %**, kimi-k2.6
    **47.8 % → 18.7 %**. Handles were lower in all 8 question × model pairs (one-sided sign test
    p ≈ 0.004).
  - Every citation in the on arm was an exact copy of a handle (0 out of range).
  - Most unsupported citations in the off arm had their specifics on **another** result of the
    same turn (deepseek 62 of 80, kimi 28 of 32): the wrong-page failure that handles address. What
    remains in the on arm is mostly wrong attribution or the model's own knowledge.
  - Answer quality: on 4 wins, off 2, 2 ties. Both off wins came from content errors, not
    citations. No regression.
- **Caveats.**
  - Recall was on, so off-arm turns could recall on-arm answers. Excluding near-copied claims
    the gap holds (deepseek 11.1 % vs 67.6 %, kimi 17.4 % vs 56.8 %), and so does a comparison
    restricted to search results (deepseek 18.8 % vs 64 %, kimi 19.1 % vs 46.3 %).
  - kimi-k2.6 lost 3 citations by copying the 36-character id with one character missing. The
    resolver had no typo repair, so they rendered as nothing. Shorter ids were a possible
    follow-up. **Since 2026-10-06** (lab, staging and prod) the resolver maps an id one
    character off exactly one call of the turn to that call, and a shortened id to the one call
    it starts ([D44](#d44-shortened-and-one-character-off-citation-ids-resolve)).
  - **Open question:** with handles on, deepseek-v4.1-flash fetched a page on 4 of 4 turns, 0 of
    4 off (about +30 s per turn). Confounded with recall; not explained. Watch prod
    `tool_calls` and `fetch_ms` ([telemetry](/operations/telemetry#tokens-citations-and-totals)).
  - Small sample: 16 turns in total. The counters (`citations_unresolved`) cannot confirm the
    effect on prod, because a wrong-page anchor resolves; judge a sample of prod answers.
- **Related fix: reloaded speed-mode citations.** Before saving, `rehydrateFullContent`
  replaced a search's `results` wholesale with the recorded full list. On the speed fast path
  that list predates the per-turn URL dedup, so a reloaded answer's `[N](#id)` could resolve to
  a different page than it did live. Full content is now swapped in by URL, keeping the live
  order and length (`lib/search/rehydrate-full-content.ts:44-57`)
  ([known issue](/history/known-issues#reloaded-speed-mode-answers-cited-a-different-page)).
- **Revert.** Set `CITATION_HANDLES=off` in that env's `.env` (prod: the Model Manager's Search
  tab has a "Ready-made citation handles" switch that writes `on`/`off`) and force-recreate
  `ask`; no rebuild. On the lab the overlay takes the value from the shell:
  `CITATION_HANDLES=off docker compose … up -d --force-recreate ask`. Check with
  `docker exec <container> printenv CITATION_HANDLES` (empty or unset means on). The reload fix
  has no switch.
- **Tests.** `lib/utils/__tests__/citation-handles.test.ts`,
  `lib/tools/__tests__/search-to-model-output.test.ts`,
  `lib/tools/__tests__/fetch-citation-handles.test.ts`,
  `lib/streaming/helpers/__tests__/document-retrieval-part.test.ts`,
  `lib/agents/prompts/__tests__/search-mode-prompts.test.ts` ("citation guidance under
  CITATION_HANDLES") and `lib/agents/__tests__/citation-handles-e2e.test.ts` (a stubbed model
  copies every handle it is shown; each renders its own result; nothing stored carries `cite`).
- **Revisit if** judged prod answers show the support rate slipping back, near-miss id copies
  become common (then shorten the ids, with a lab A/B), or the extra deepseek fetches are
  confirmed on prod and cost more latency than the citations are worth.

### D43. Snippet citations: measured, not re-pointed

- **Status:** adopted (evidence telemetry); two fixes **rejected** · **Date:** 2026-10-01 (lab,
  staging and prod; deployed 10-01/02) · **Commit:** `01f07ef9` (lab `8922368d`, staging `f18717ab`).
- **Context.** In the 2026-09-30 quality re-test, citations of a search snippet (at most 1,000
  characters) were judged unsupported by their stored text 71 % of the time, against 23 % for
  citations of page text ([D40](#d40-quality-mode-read-pages-past-the-search-cap), findings).
  The working theory was "the model read the fact on a page it fetched and cited the snippet of
  that same page", and the proposed fix was to point such a citation at the fetched page.
- **Diagnosis.** The theory explains almost none of them. All 68 snippet citations judged
  unsupported or partly supported cite a URL that was **not** fetched that turn (the original
  judge had already merged in the page text of the same URL where it existed), and on prod 1 of
  133 snippet citations since 2026-09-28 had its own URL fetched in the same turn. Each of the 68
  was re-judged against the cited page fetched live and against every other page of the turn:

  | Verdict | Share | Detail |
  |---|---|---|
  | Right for the reader | 28 % (19) | the snippet itself supports the claim (2); the same page was read under another URL (1); the live cited page supports it (16; caveat: fetched one to two days later, and 5 of the 16 are also supported elsewhere) |
  | Wrong page | 32 % (22) | another page of the turn supports it and the cited one does not; in 21 of 22 that page was page text (a fetched page or a page crawled in the first search) |
  | Nothing retrieved fully supports it | 40 % (27) | 20 partly supported, 7 not at all; 9 of the 27 are table rows assembled from several sources |

  The real problems are **wrong-page attribution** and **numbers the model assembled**. How
  common snippet citations are: of 567 rendered citations in the re-test, 55 % cite page text,
  5 % a snippet whose page the turn read, 40 % a snippet only; on prod since 2026-09-28, 290
  rendered, 54 % page and 46 % snippet only.
- **Decision.** Measure on every turn and change nothing the reader or the model sees. Evidence
  helpers in `lib/utils/citation.ts` ([frontend › Citation evidence](/request-lifecycle/frontend#citation-evidence)):
  `SNIPPET_MAX_CHARS` = 1000 (`:582`); `samePageKey()` (`:605-634`), which treats as one page
  the spellings that differ in scheme, `www.` / `m.`, case, trailing slash, fragment, tracker or
  empty parameters and parameter order, and a GitHub repository page, its `?tab=` views and its
  `/blob/<branch>/README`; `findPageTextForUrl()` (`:701-715`), message-scoped, never crossing
  turns ([D36](#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)); and
  `auditCitationEvidence()` (`:751-811`), which sorts the rendered citations into page /
  snippet-read / snippet and counts fetched pages nothing cites. They become `citations_snippet`,
  `citations_snippet_read` and `fetch_pages_uncited` on the `[latency]` line
  ([telemetry](/operations/telemetry#tokens-citations-and-totals)). Rendering, the hover preview
  and the model-facing output are unchanged.
- **Rejected 1: repeated in-page cite markers.** Each page's citation handle repeated every
  ~2,000 characters inside its text, so a fact read deep in a page has its handle next to it.
  Built on the lab behind `CITATION_PAGE_MARKERS` and removed; it is in no commit. Measured on
  17 answers:
  - Citations moved: snippet 35 % → 23 %, page 60 % → 74 %.
  - Support did not improve: supported 42 % → 36 %, unsupported 26 % → 29 %, and unsupported
    **page** citations 10 % → 17 %.
  - 2 of the 17 answers dropped the `#` from every anchor, so not one of their citations rendered.
  - Prompt +3–5 %.

  **Do not retry** unless a judged comparison shows support improving, not just citations moving
  onto pages, and no answer losing its anchors.
- **Rejected 2: automatic re-pointing.** Move each snippet citation to the page of the turn whose
  text best matches the claim (word overlap). Replayed offline on the 68: it would fire on 54,
  the new page supports the claim in only 19, and it would move 9 of the 16 correct citations to
  pages that do not support them. A silent re-point is a guess the reader cannot see, the same
  reason the resolver never guesses a wrong number on a multi-result call
  ([D36](#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only)). **Do not
  retry** without a matcher that, on a judged set, fixes clearly more citations than it breaks.
- **Method for the next model-facing variant.** Replay stored turns offline before any live A/B:
  apply the variant to what the model is shown, re-run the answer step on the stored tool
  results (as the D40 reminder replays did), and judge every citation against the cited result
  **and** every page of the turn. It isolates the variant from search non-determinism and fires
  no live searches. Then confirm with a judged lab A/B
  ([D4](#d4-judge-answers-not-source-counts)). Judge support, never the snippet share alone:
  rejected fix 1 lowered the share and lowered support with it. The judged sets and the replay
  harness are not in `scripts/eval/`.
- **Tests.** `lib/utils/__tests__/citation-evidence.test.ts`,
  `lib/streaming/__tests__/latency-tracker.test.ts`.
- **Revisit if** the prod snippet share (`citations_snippet` over rendered citations, 46 % before
  the build) moves after a prompt or tool-output change, or when a fix for wrong-page attribution
  or assembled numbers is proposed (evaluate it with the method above). Open issue:
  [known issues](/history/known-issues#citations-point-at-a-snippet-instead-of-the-fetched-page).

### D44. Shortened and one-character-off citation ids resolve

- **Status:** adopted · **Rollout: lab, staging and prod** · **Date:** 2026-10-06 ·
  **Commit:** lab `6b779bfe`, staging `5ab6760f`, prod `a89fb3f2`.
- **Context.** glm-5.3-flash writes anchors with a truncated id, `[3](#17d98f5d)`,
  `[1](#71cee5ba...)`, `[2](#74661147-...)`, for this turn's
  `17d98f5d-f270-46f8-92e8-e2acaa3a4705`, although every result hands it the full id in its
  `cite` string ([D38](#d38-ready-made-citation-handles)). Such an anchor rendered as nothing: on
  prod 48 of its 121 citations were unresolved, and 43 of the 48 it lost since 2026-10-04
  carried the right id cut to its first 8 characters. The same shape occurs in final answers
  (prod glm-5.2 history, lab deepseek-v4-flash). Separately, kimi-k2.6 and deepseek-v4-flash
  sometimes copy a full id with one character changed, dropped or added: 17 anchors across the
  three stacks' history, each within one edit of exactly one call of its own turn and of no
  other id. D38 recorded that near-miss as a caveat.
- **Decision: two more repairs in the one resolver.** `resolveCitationAnchor`
  (`lib/utils/citation.ts:376-411`) tries them after the id as written and the unwrapped
  template id, and before the placeholder and URL-fragment rules (`:393-398`). Each names one
  call of **this message** or nothing; N is then resolved against that call exactly as for its
  full id, out-of-range rules included (`resolveWithinCall`, `:317-351`). Both return
  `recovered` with the repair's name (`CitationRepair`, `:187-199`), so the anchor renders and
  counts in `citations_recovered`, not in `citations_unresolved`.
  1. **`id-prefix`** (`findMapByIdPrefix`, `:256-276`). Trim whitespace, one trailing ellipsis
     (`...` or `…`) and trailing dashes. What remains must be at least `MIN_ID_PREFIX_LENGTH` = 8
     hex/dash characters (`:234`) and a case-insensitive prefix of **exactly one** of this
     message's citable call ids. Shorter, ambiguous (two calls start with it), a prefix of no
     call of this message (another turn's, or invented), or followed by anything but an
     ellipsis (`7affb9b0-... FAQ`, `7affb9b0..`, `toolu_7affb9b0`): dropped.
  2. **`id-typo`** (`findMapByIdTypo`, `:300-315`, with `isOneEditApart`, `:279-287`). A
     hex/dash id one substitution, insertion or deletion away from **exactly one** of this
     message's UUID-shaped call ids. Two characters off (a swap of two neighbours is two
     edits), one edit from two calls, or one edit from another turn's id: dropped.
- **Why these are not guesses.** Eight hex characters are the first group of a UUID, the
  git-style shortening models produce, and 16^8 values: two calls of one turn never share such a
  prefix by chance, and an invented 8-character id never matches one by chance. Two random
  UUIDs are never one edit apart, so a one-edit match names its call as surely as the full id.
  Only UUID-shaped calls are `id-typo` candidates, the shape whose length makes one edit
  meaningful. Per-turn scoping ([D36](#d36-strip-historical-citation-anchors-resolve-citations-per-turn-only))
  is unchanged: no repair looks at another message's calls. The rationale and measurements are
  also in the code comments (`:228-255`, `:289-299`).
- **Evidence.** Every stored answer replayed through the old and the new resolver: unresolved
  anchors prod 750 → 700, staging 1048 → 1044, lab 323 → 289; 0 previously rendered citations
  changed.
- **Caveat found in the replay.** The recovered glm anchors sat in planning text the model had
  leaked in front of its answer, not in the answer. Recovering them alone would have rendered
  source chips inside a draft the reader should not see, so the draft cut
  ([D20 › Decision 7](#decision-7-a-planning-draft-in-front-of-a-glued-restart-is-cut)) ships
  with this change.
- **Telemetry.** On lines from a build with this change, the same answers report fewer
  `citations_unresolved` and more `citations_recovered`; compare rates only between lines of one
  build ([telemetry](/operations/telemetry#tokens-citations-and-totals)).
- **Tests.** `lib/utils/__tests__/citation.test.ts`: "shortened ids", "full-length ids one
  character off", and "shortened and mistyped ids: audit, rendering and cited URLs agree".
- **Revisit if** a model's unresolved anchors are near-misses of its turn's ids in a shape not
  covered here (fewer than 8 characters, two edits). Measure how often such a shape is ambiguous
  in stored turns before widening either rule: a repair that can name the wrong call is worse
  than a dropped anchor (D36).

## Retrieval policy

### D37. Always search every question

- **Status:** adopted · **Date:** 2026-09-26 (owner decision; lab, staging and prod the same day)
  · **Commit:** `0ea17872` (lab `453bfba1`, staging `3822f475`). Reverses
  [D3](#d3-needssources-skip-retrieval-for-stable-knowledge).
- **Context.** Under D3 the classifier could send a question down one of two no-search paths:
  `direct` (`skipSearch`, "the conversation already answers this") or `stable-knowledge` (no
  sources or recency needed, `search` not advertised). Over the 60 days before this change, 69 of
  164 prod turns used no tools: 20 `skipSearch` turns and 47 `stable-knowledge` turns. Many were
  about named products, company policies, home repair and cleaning, health and safety, or current
  fiction, answered confidently from memory. An answer about melted plastic on an oven tray
  recommended acetone with no fire warning.
- **Decision.** Every question gets a web search. Only a message that is not a question may skip
  it.
  1. **What may skip.** The classifier's new `CLASSIFIER_SYSTEM_PROMPT`
     (`lib/agents/query-classifier.ts:234`) sets `skipSearch=true` only for:
     - social talk that asks for nothing: a greeting, thanks, an acknowledgement, chit-chat,
       venting or a rhetorical remark;
     - a pure transform of text already present (the user's text or the previous answer):
       rewrite, rephrase, shorten, translate, summarise, reformat. It must ask for no new
       information. Asking for a recommendation, decision, verdict or reasoning is **not** a
       transform;
     - pure arithmetic or a unit conversion on numbers given in the message;
     - a request only to generate, draw or edit an image;
     - an explicit instruction to remember, forget or update something about the user that asks
       nothing else (added the same day, see "`remember` writes" below). One that also asks a
       question ("remember I'm vegetarian — what can I cook tonight?") searches.

     Every question searches, including follow-ups that confirm, choose, clarify or apply the
     previous answer, and questions the conversation already seems to answer. If the classifier
     is unsure, it searches. `needsSources` is still produced, but only for analysis: it gates
     nothing.
  2. **Turn mode.** `resolveTurnMode` (`lib/agents/researcher.ts:178-212`): `skipSearch` →
     `direct`; everything else → `research`. `stable-knowledge` cannot be reached while the flag
     is on.
  3. **A guaranteed first search.** On a `research` turn, `prepareStep` gives step 0 to a
     synthetic model instead of the user's model (`researcher.ts:1202-1204`).
     `createForcedSearchModel` (`lib/agents/always-search.ts:264`) is a `LanguageModelV3` whose
     only output is **one `search` tool call**. Its query is the classifier's `standaloneQuery`
     with URLs removed, clipped at a word boundary to 400 characters (`resolveForcedSearchQuery`,
     `always-search.ts:61-73`). The call spells out every schema field and carries the turn's
     `firstSearchDepth` (`buildForcedSearchInput`, `:204-218`). The AI SDK validates and runs it
     exactly like a call the model made. It goes through the real, wrapped `search` tool, so
     source forcing, dedup, the answer deadline, the round cap, expansion fan-out, advanced depth
     and telemetry all apply. The result streams to the browser, is persisted, and is citable by
     its toolCallId. The user's model answers from step 1 with those results in context.
  4. **The prompt is told.** `FORCED_SEARCH_PROMPT_ADDENDUM` (`always-search.ts:319`, appended at
     `researcher.ts:861-863`) says the first search has already run, asks for the answer to be
     grounded and cited, and cancels the mode prompts' "clarifying your own prior answer, do not
     search" exception. Since 2026-09-27 it also says this is the first search, not the only one
     (addendum below). It is appended after the mode prompt, so it wins. Since 2026-09-27 it is
     appended through `getForcedSearchPromptAddendum()` (`always-search.ts:330-338`), which
     swaps the citing sentence for "copy each result's `cite` string" while `CITATION_HANDLES`
     is on ([D38](#d38-ready-made-citation-handles)).
- **Why not `toolChoice`.** The obvious lever is `prepareStep` returning
  `toolChoice: { type: 'tool', toolName: 'search' }`. But `ai-sdk-ollama` 3.8.4, the provider for
  every answering model, never reads `toolChoice`: its `getCallOptions` takes the prompt, sampling
  settings, `responseFormat` and `tools` and nothing else, and its request carries no tool choice
  (`node_modules/ai-sdk-ollama/dist/index.js:16108-16120`, `:16865-16876`).
  [D9](#d9-search-round-cap-enforced-inside-the-tool) and the classifier's `toolChoice:
  'required'` comment record the same finding. A prompt mandate was not enough either: the
  research prompts already say "your FIRST action in every turn (without a URL) MUST be the
  `search` tool", yet on the lab about one research turn in three still made no tool call. The
  per-step `model` override is applied by the AI SDK itself, so no provider can drop it, and the
  step that would have spent a model round trip deciding to search now costs about 0 ms.
- **Which turns are forced.** The code lives in `createResearcher`, so logged-in and guest turns
  behave the same.
  - **Forced:** every `research` turn where the user did not supply the source and the resolved
    query still has text after URLs are removed (`resolveForcedFirstSearch`,
    `researcher.ts:223-240`).
  - **Research but not forced: the user supplied the source** (follow-up the same day,
    `detectUserSuppliedSource`, `lib/agents/always-search.ts:118-137`, read from the latest
    message's parts). A URL in the text or a pasted link chip: the first version searched the
    text around the URL ("summarise this https://…" searched "summarise this"), overriding the
    mode prompts' "a URL: fetch it, do not search first" rule; a URL turn is now exactly the
    research turn it was before D37 (same prompt, same tools, no addendum). An attachment with
    no typed text: the classifier sees text only, so it classified an empty message and
    invented a query. An attachment whose text only points at it ("what is this", "summarise
    this file"; `isAttachmentReferenceOnly`, `always-search.ts:183-193`, a closed word list, at
    most 10 words): the attachment is the subject, which the model sees. An attachment with a
    real question is still forced. The log says `always-search: the user supplied the source
    (<reason>)`; a query with nothing left after URLs are removed logs `nothing searchable in the
    resolved query`.
  - **Bypass paths** (speed mode, a URL in the message, Retry, a classifier failure, empty reply
    or soft-budget timeout) have no classifier rewrite: `standaloneQuery` is the raw message, so
    apart from the URL and attachment cases above the forced search runs on the raw text. That
    is what those paths searched before. Guest turns bypass the classifier only for a URL
    (`lib/streaming/create-ephemeral-chat-stream-response.ts:92-107`) and apply the same
    user-supplied-source check.
- **Telemetry.** The `[latency]` line gains `turn_mode`, `forced_search` and (with the
  follow-up) `forced_skip`, the user-supplied-source reason
  (`lib/streaming/latency-tracker.ts:336-340`, set from `onTurnPlan` at
  `lib/streaming/create-chat-stream-response.ts:844-846`). The container log also gets
  `[Researcher] always-search: step 0 forced to search "<query>"`. On a forced turn the synthetic
  step emits at once, so `ttft_ms` and `first_step_ms` measure only the pre-work (about 2 s). Use
  `stream["text-start"]` for the time to first prose. Guest turns write no `[latency]` line.
- **Evidence (lab, 2026-09-26).**
  - Classifier replay of those 164 prod turns with the new prompt: 145 search, 19 skip (11 image
    requests, "hello", "hi", 3 transforms, one venting message, "so nothing exciting").
  - Browser check: TCP vs UDP, a clarification follow-up and the oven question were all
    force-searched and answered with citations; "Thanks, that's helpful!" stayed `direct`.
  - Blind pairwise A/B ([D4](#d4-judge-answers-not-source-counts) method: answering model
    kimi-k2.6, judge deepseek-v4-pro, both orderings, recall and memory off, validity filter).
    6 of 12 pairs were valid; on the other 6 the old gate had searched anyway. Forced search
    scored **2W-1L-3T**: it won the oven safety answer and the sourcing of TCP vs UDP, and lost a
    troubleshooting question where the search led to a confident, wrong root cause.
- **Caveat: the older evaluations went the other way.** D3's judge (46 pairs, 13W-2L-3T for *not*
  searching, July) and D4's (forcing retrieval: 1W-7L-3T on operational and 1W-8L-1T on concept
  questions, August) were larger. Six valid pairs cannot overturn them.
  D37 is an owner decision on correctness and safety grounds, not a measured quality win, and the
  quality effect should be treated as open.
- **Cost.** Questions that used to skip search start their prose about 7–20 s later: median time
  to first prose went from about 3 s to about 21 s in the A/B, and 10–15 s in the lab browser
  check. The forced search also uses round 1 of the turn's `SEARCH_ROUNDS_MAX` budget.
- **Interplays and weak spots.**
  - **`FLOW_VARIANT`** (lab only; `baseline` or unset everywhere): a non-baseline variant loses
    its own step-0 control. The forced model replaces step 0 whatever the variant asks for, for
    example `plan-execute`'s forced `todoWrite` or `adaptive`'s optional search.
  - **`ANSWER_THINK=targeted`** ([D18](#d18-targeted-reasoning-reasoning-only-on-research-turns),
    lab only, unset everywhere) would now turn reasoning on for almost every turn.
  - **[D19](#d19-follow-up-re-search-prompt-nudge)** no longer decides the first search of a
    follow-up; it still governs re-searching.
  - **Speed mode and Retry** skip the classifier, so a contextual follow-up is force-searched on
    its unresolved text ("which one should I pick?"). The model can search again with a better
    query, at the cost of a round.
  - **Image plus "what is this"**: the classifier sees only text, so the first version forced a
    search for "What is this?". Fixed by the user-supplied-source exception above; an image with a
    real question is still searched on its words alone
    ([known issue](/history/known-issues#image-attachment-forces-a-generic-search)).
  - **`remember` writes**: `remember` is candidate-only on research turns
    (`researcher.ts:944-953`), so a "remember that …" message must stay `direct` to be confirmed.
    Checked on the lab classifier (`deepseek-v4-pro:cloud`, single message and as a second turn):
    "remember that I'm vegetarian", "remember I prefer metric units" and "forget my address"
    were already `skipSearch:true` under both the legacy and the first ALWAYS_SEARCH prompt, so no
    regression was observed; the first prompt's skip list simply did not name them. The follow-up
    names them in the skip list with examples, so the behaviour no longer depends on the
    classifier model. Lab browser check: "remember that I prefer metric units" →
    `turn_mode:"direct"`, the `remember` tool ran, and the memory row is `confirmed`. On a research turn
    the background extractor can still rescue it: when it extracts a near-duplicate (similarity ≥
    `MEMORY_SIM_THRESHOLD`, 0.9), the bump to 2 sightings graduates the candidate (`decideWrite`,
    `lib/memory/write.ts:35-51`); a differently worded extraction does not
    ([memory](/knowledge/memory-recall#candidate-vs-confirmed-and-the-prompt-injection-mitigation)).
- **Revert.** Set `ALWAYS_SEARCH=off` in that env's `.env` (the Model Manager's Search tab has an
  "Always search" switch; it writes `on`/`off` and rejects `false`) and force-recreate `ask`; no
  rebuild. Only the literal `off` disables it; unset, empty or any
  other value leaves it on (`isAlwaysSearchEnabled`, `always-search.ts:32-36`). The flag is read
  per call, so the recreate is only needed to change the container's environment. Off restores
  the legacy classifier prompt (`getClassifierSystemPrompt`, `query-classifier.ts:296-302`) and
  the D3 gate exactly. Check with `docker exec <container> printenv ALWAYS_SEARCH`.
- **Revisit if** the forced searches make answers measurably worse on judged turns (not on counts;
  see D4), or the latency cost starts to hurt. The skip definition is the lever to tune first, not
  the forcing mechanism.
- <span id="addendum-2026-09-27-the-forced-search-is-the-first-search"></span>**Addendum
  2026-09-27: the forced search is the first search, not the only one.** Commit `facc98f3`
  (lab `8c4a28b2`, staging `9c24ed64`).
  - **What was wrong.** The addendum ended: "Search again or fetch a page only if those results
    leave a specific gap you can name; if they turn out irrelevant, answer from what you know
    and do not cite them." It is appended after the mode prompt, so it wins over it. That
    sentence overrode quality mode's deep-research protocol (plan with `todoWrite`, then many
    searches with different phrasings and a gap check,
    `lib/agents/prompts/search-mode-prompts.ts:484-520`) and balanced mode's ordinary follow-up
    searching, and "answer from what you know" reopened the memory-only answers D37 exists to
    stop.
  - **What the numbers showed, and how little.** Prod `latency:log`: the 41 turns (balanced and
    speed) with at least one tool call logged before always-search had a median of **3** tool
    calls; the 4 forced
    research turns logged after it had a median of **1**. But 2 of those 4 were turns hung by
    the [Redis incident](/history/known-issues#search-hung-after-the-weekly-redis-update), whose
    only call never returned; the 2 healthy ones made 1 and 2 calls. The lab (mostly
    kimi-k2.6, all balanced) had 33 forced turns on the old wording: median 2, and 16 of them
    made a single call. The change rests on the wording contradicting the protocols; the counts
    only point the same way.
  - **New wording** (`FORCED_SEARCH_PROMPT_ADDENDUM`, `lib/agents/always-search.ts:319-322`):
    "Treat it as your FIRST search, not your only one: continue your research exactly as the
    protocol above describes — search again with different queries (never repeat this one) and
    fetch pages for anything the question needs that these results do not already settle …
    If these results turn out irrelevant, search again with a better query instead of answering
    from memory." The `CITATION_HANDLES` variant (`getForcedSearchPromptAddendum`, `:330-338`)
    swaps only the citing sentence, so it carries the same text. The test "frames the forced
    search as the first search, not the only one" (`lib/agents/__tests__/always-search.test.ts`)
    also fails if "only if those results" or "answer from what you know" comes back.
  - **First lab turns on the new wording** (kimi-k2.6, as of 21:00 UTC on 09-27): four balanced
    forced turns made 2, 3, 5 and 6 tool calls, a quality turn 9 and a speed turn 1. Too few to
    call; it is the direction intended.
  - **Unchanged.** Every search after the first is basic depth and counts against
    `SEARCH_ROUNDS_MAX` (3; 5 in quality), see [D9](#d9-search-round-cap-enforced-inside-the-tool).
    The expansion variants (up to 3) still run inside the forced call itself, so the UI shows
    one search entry for them and `tool_calls` counts one call
    ([pipeline](/search/pipeline#_3-expansion-variants)).
  - **Watch** on prod lines from `facc98f3` onward: `tool_calls` and `total_ms` of research
    turns per `modelId` and mode. More searches cost time; whether they make better answers is
    a judging question ([D4](#d4-judge-answers-not-source-counts)), not a count.

### D40. Quality mode: read pages past the search cap

- **Status:** adopted; the answer-step citation reminder is **shelved** (built, off by default) ·
  **Date:** 2026-09-29 / 09-30 · **Commits:** prod `a6db72f1` + `30838a61` (lab `49379e09` +
  `98ba1d36`; staging `4b5f6fd3` + `7a2d74ba`). The prod and staging ports call
  `getModel(model, abortSignal)` with two arguments: the lab's third argument (the turn mode
  that `ANSWER_THINK=targeted` reads, [D18](#d18-targeted-reasoning-reasoning-only-on-research-turns))
  exists only on the lab.
- **Context.** Quality mode capped `search` at 5 rounds ([D9](#d9-search-round-cap-enforced-inside-the-tool)),
  and the cap's notice said "answer now from the sources already gathered", which in practice
  also ended fetching. A near-duplicate skip ([pipeline › dedup](/search/pipeline#round-cap))
  also used up a round.
- **Decision.**
  1. **A round counts only for a search that runs.** The counter moved after the
     near-duplicate check (`lib/tools/search.ts:562-564`).
  2. **The cap ends the searching, not the reading.** In a mode that has a fetch cap, the cap
     notice (`buildSearchRoundCapNotice`, `lib/tools/search.ts:346-358`) refuses further
     searches but lets the model `fetch` URLs that this turn's searches returned when a claim
     needs the page's full text. Modes without a fetch cap keep the "answer now" wording.
  3. **A per-turn fetch cap.** `FETCH_ROUNDS_MAX_QUALITY` (default 8 calls) for quality,
     `FETCH_ROUNDS_MAX` for the other modes (unset = no cap), in `lib/tools/fetch-budget.ts`
     and enforced in `lib/tools/fetch.ts:691-713`. A refused call returns a non-error notice.
  4. **Quality search cap 5 → 10** (`SEARCH_ROUNDS_MAX_QUALITY`, `lib/tools/search.ts:315`).
     Speed and balanced stay at 3.
  5. **The answer-step citation reminder stays off** (`CITATION_REMINDER=on` enables it).
- **Evidence** (lab A/Bs, kimi-k2.6, recall and memory off; the raw runs are internal, only
  the results are recorded here):
  - **A/B 1 (2026-09-29), cap 5 vs cap 15, old notice, 3 quality questions.** Cap 15 was
    clearly better: two judges scored it 2-0-1 and 3-0-0 (win-loss-tie). The difference was
    reading: cap 15 fetched 34 pages, cap 5 fetched 1 across its 3 turns (it hit the cap on all
    3) and answered from snippets. One cap-5 answer reported a trial's result as null from a
    401-character snippet; the cap-15 arm read the page and found the primary endpoint was
    met. A false-positive dedup skip cost one cap-5 turn 1 of its 5 rounds (and two cap-15
    turns 2 and 1). **But citations degraded on the long runs:** the 18-call turn (a
    103k-token final prompt) wrote 13.9k characters with no citation at all, and the 15-call
    turn numbered its sources as a running count under whole sections, 4 of whose anchors
    pointed past the cited call's results. Neither turn hit the answer deadline, the step
    ceiling or the cap.
  - **A/B 2 (2026-09-30), cold cache, 4 quality questions × 3 arms.** C: cap 10, no reminder.
    D: cap 10 + reminder. E: cap 5 + reminder. Fetching past the cap was used in all 3 E turns
    that hit the cap, and in 0 of 3 turns at cap 10. Cap 10 vs cap 5 showed no measurable
    quality or latency difference (q1–q3: 209 s vs 203 s), and D tied the stored cap-15
    answers. Sizing: cap 10 would have refused none of the real searches the cap-15 arm made
    (7, 5 and 10) once skips stopped counting, and its fetch calls per turn (6, 3 and 7) fit
    under 8.
- **The reminder, and why it is off.** Citation rules live only in the system prompt; on a long
  loop the answer step starts 100k+ tokens and a dozen tool turns away from them. In stored lab
  history (296 answers ≥ 1,500 characters) every bucket up to 11 search/fetch calls averaged
  3.1–3.6 citations per 1,000 characters, while the 4 turns with 12+ calls averaged 0.95. The
  reminder (`lib/agents/citation-reminder.ts`) re-states the rules on the step that writes the
  answer once at least `CITATION_REMINDER_MIN_TOOL_CALLS` (8) search/fetch calls are behind
  it. `createAnswerStepReminderModel` (`lib/agents/answer-step-reminder.ts`) buffers the step's
  stream: a tool call passes through untouched; answer text (a markdown heading, or 280
  characters without a tool call) aborts that attempt at the HTTP layer and re-runs the step
  once with the reminder as a trailing **user** message. On the answer-deadline step (tools
  withdrawn), or since 2026-10-07 a search-cap answer-only step
  ([D45](#d45-search-withdrawn-after-the-round-cap-then-answer-only-steps)), it is appended
  directly. Wiring: `lib/agents/researcher.ts:1001-1039`, `:1158-1195`.
  - *Why user, not system:* Ollama drops a system message that is not the first one for
    kimi-k2.6 (`prompt_eval_count` unchanged); glm-5.3-flash did render it.
  - *Why only on the answer step:* replays showed the same trailing message also steers the
    research loop, in a wording-dependent direction (one wording made the model stop at step
    8, another made it call tools 6 of 6 times at the answer step).
  - *Replays* of the two degraded turns: the unchanged context cited badly again; the reminder
    as a trailing user message made 7 of 9 answers copy the `cite` strings (one partly, one
    still counted).
  - *Live (A/B 2):* the re-run fired on every armed long turn, but running-count numbering
    still appeared in 2 of 3 of them, the cleanest long turn (18 calls) had the reminder off,
    and each re-run re-sends the whole prompt (58–104k extra prompt tokens). So it is off.
- **Gotcha for any future mid-conversation instruction.** With kimi-k2.6 through Ollama, an
  instruction added after the first message must be a **user** message or tool-result content;
  a later system message is silently dropped.
- **Findings left open** (in [known issues](/history/known-issues)):
  - **Snippet citations.** Citations to a search **snippet** (at most about 1,000
    characters) were judged unsupported 71 % of the time, against 23 % for citations of page
    text. The first explanation, a fact read on a fetched page and credited to that page's
    snippet, turned out to be rare; re-judged on 2026-10-01, they are mostly the wrong page or
    a number the model assembled. Measured on every turn since, not fixed
    ([D43](#d43-snippet-citations-measured-not-re-pointed),
    [known issue](/history/known-issues#citations-point-at-a-snippet-instead-of-the-fetched-page)).
  - **Dedup false positives.** At threshold 0.92, 6 of 7 skips of templated
    "X GitHub features license" queries were false positives; the search was still dropped,
    though no longer counted as a round. **Fixed 2026-10-01**: a skip now needs an exact or a
    word-checked near repeat ([D42](#d42-near-duplicate-search-skip-only-for-true-repeats),
    [known issue](/history/known-issues#near-duplicate-dedup-drops-templated-queries)).
  - **The URL limit is advisory.** Nothing checks that a URL fetched past the cap came from
    this turn's results; in one test the model fetched GitHub URLs it constructed
    ([known issue](/history/known-issues#the-fetch-past-the-cap-url-limit-is-advisory)).
- **Consequences.** A quality turn can now make up to 10 searches and 8 fetch calls (up to 40
  pages), still inside the 200 s answer deadline and the 100-step ceiling. The quality prompt
  still asks for at least 15 searches, more than the cap allows; the cap's notice is what
  stops it.
- **Do not retry** the answer-step reminder as a default unless a new mechanism avoids the full
  re-run and a judged A/B shows it removes running-count numbering; A/B 2 says the reminder
  alone does not.
- **Revisit if** quality answers start missing facts that only a page had (look at
  `fetch_allowed` on `round-cap` lines and `[fetch] fetch cap reached`), or if the snippet
  finding gets a fix that changes what the model can cite.

## Reliability

### D39. Every local Redis client goes through `local-redis.ts`

- **Status:** adopted · **Date:** 2026-09-27 (lab, staging and prod the same day) ·
  **Commit:** `2f5eac13` (lab `a9c5914a`, staging `c0df517f`).
- **Context.** Seven modules each built their own module-level node-redis client with a bare
  `createClient({ url }) + connect()`: no `'error'` listener, the default offline queue, no
  command timeout. When the weekly update recreated Redis under the running app, those clients
  threw before reconnecting and then held every command forever. Every balanced and quality
  search hung for about 8.5 hours while every health check stayed green
  ([known issue](/history/known-issues#search-hung-after-the-weekly-redis-update)).
- **Decision.** Code that talks to the env's local Redis gets its client from
  `createLocalRedisConnector('<label>')` (`lib/redis/local-redis.ts:213`) and never calls
  `createClient` itself. The connector:
  - registers an `'error'` listener that logs `[redis:<label>] …` once per change of error and
    never rethrows, so node-redis's own reconnect runs; `ready` after an error logs
    `[redis:<label>] reconnected` (`:117-129`);
  - sets `disableOfflineQueue: true`, so a command issued while disconnected rejects at once
    instead of queueing (`:103-110`);
  - bounds each connect attempt at 2 s and backs off `min(retries × 200, 2000)` ms (`:37`,
    `:54-56`);
  - bounds every command at `LOCAL_REDIS_COMMAND_TIMEOUT_MS` (1000 ms), because a half-open
    socket answers nothing and node-redis takes minutes to notice (`:48-51`, `:150-180`);
  - waits at most ~2.5 s for the first connect, then `get()` returns `null` immediately while
    the client is not ready, and rebuilds a client that is closed or has timed out 3 commands in
    a row (`:218-223`, `:250-263`, `:288-298`).

  The callers keep their own outage semantics, because the connector only turns a hang into a
  fast rejection or a `null`: the Brave, Tavily, LangSearch and Replicate budgets **fail
  closed**, the search caches miss, the ingest heartbeat reads "unknown", the imagegen rotation
  and retry counters fall back to memory (for the rest of the process, as before). Upstash REST
  clients are not built here; callers keep their Upstash branches.
- **Exceptions, and why.** `lib/telemetry/latency-store.ts` (also used by the quotes cache) and
  `lib/streaming/resumable-stream-context.ts` already register `'error'` listeners, and the
  resumable stream's pub/sub connections rely on the offline queue, so both keep their own
  clients.
- **The other half.** The search tool bounds its call to `/api/advanced-search` (20 s to headers,
  180 s total, then a basic SearXNG fallback), so any future stall in that route costs a turn
  about 20 s instead of 300 s ([pipeline](/search/pipeline#advanced-search-deadline-and-fallback)).
  And `fleet-boot/update-images.sh` restarts the app whenever a sidecar was recreated under it,
  then probes the route's Redis ([fleet scripts](/operations/fleet-scripts#update-images-sh)).
- **Evidence.** Unit tests: `lib/redis/__tests__/local-redis.test.ts` (the connector),
  `lib/redis/__tests__/caller-outage-semantics.test.ts` (each caller's outage behaviour),
  `app/api/advanced-search/__tests__/redis-resilience.test.ts` (the route and its probe),
  `lib/tools/search/__tests__/advanced-search-deadline.test.ts` and
  `lib/tools/__tests__/search-advanced-timeout.test.ts` (the deadline and fallback). On the lab,
  `ask-redis-lab` was recreated under the running app: `[redis:advanced-search] reconnected`,
  no uncaught exception, and a balanced question answered normally.
- **Do not** add a Redis-backed feature with its own `createClient`, and do not "simplify" the
  connector by dropping the error listener or re-enabling the offline queue. Either brings the
  2026-09-27 failure back.
- **Revisit if** Ask moves to Upstash or a Redis cluster (the connector is local-only), or a new
  caller needs pub/sub (give it its own client with an error listener, like the resumable
  stream).
