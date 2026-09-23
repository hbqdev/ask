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
| [D3](#d3-needssources-skip-retrieval-for-stable-knowledge) | `needsSources`: skip retrieval for stable knowledge | adopted | 2026-07-30 |
| [D4](#d4-judge-answers-not-source-counts) | Judge answers, not source counts | adopted (method) | 2026-08-01 |
| [D5](#d5-source-tiering-by-search-mode) | Source tiering by search mode | adopted | 2026-09-03 |
| [D6](#d6-classifier-on-a-cloud-model-with-expansion-fused-in) | Classifier on a cloud model, with expansion fused in | adopted | 2026-09-04 |
| [D7](#d7-cap-the-brave-crawl-to-the-top-3) | Cap the Brave crawl to the top 3 | adopted | 2026-09-07 |
| [D8](#d8-timebox-recall-classifier-and-langsearch) | Timebox recall, classifier and LangSearch | adopted | 2026-09-07 |
| [D9](#d9-search-round-cap-enforced-inside-the-tool) | Search round cap, enforced inside the tool | adopted | 2026-09-07 |
| [D10](#d10-answering-model-reasoning-off-by-default) | Answering-model reasoning OFF by default | adopted | 2026-09-09 |
| [D11](#d11-hide-raw-reasoning-in-the-ui) | Hide raw reasoning in the UI | adopted | 2026-09-09 |
| [D12](#d12-single-pass-search-instead-of-the-agentic-loop) | Single-pass search instead of the agentic loop | **reverted** | 2026-09-10 |
| [D13](#d13-prompt-caching-on-ollama-cloud) | Prompt caching on Ollama Cloud | **rejected** | 2026-09-11 |
| [D14](#d14-history-trimming) | History trimming | **rejected** (already done) | 2026-09-11 |
| [D15](#d15-source-excerpts-instead-of-full-pages) | Source excerpts instead of full pages | **rejected** | 2026-08-01 |
| [D16](#d16-two-stage-full-content-rerank) | Two-stage full-content rerank | **shelved** | 2026-08-05 |
| [D17](#d17-20k-per-page-crop-with-a-crop-position-shadow) | 20k per-page crop + crop-position shadow | adopted (experiment) | 2026-08-06 |
| [D18](#d18-targeted-reasoning-reasoning-only-on-research-turns) | Targeted reasoning (research turns only) | **inconclusive** | 2026-09-19 |
| [D19](#d19-follow-up-re-search-prompt-nudge) | Follow-up re-search prompt nudge | adopted (soft) | 2026-09-19 |
| [D20](#d20-narration-strippers-strict-at-persist-best-effort-live) | Narration strippers: strict at persist, best-effort live | adopted | 2026-09-10 / 09-17 |
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

- **Status:** adopted · **Date:** 2026-07-30 · **Commit:** `74062395`
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

### D9. Search round cap, enforced inside the tool

- **Status:** adopted · **Date:** 2026-09-07 · **Commit:** `53f03c4f` (lab `fb78c847`)
- **Context.** After D5–D8, real balanced turns still looped up to **7** `search` calls (~15 s
  fan-outs plus ~57 s of inter-call model reasoning).
- **Decision.** `SEARCH_ROUNDS_MAX` (default 3) and `SEARCH_ROUNDS_MAX_QUALITY` (default 5). The
  cap is enforced **inside the search tool's `execute`** (`lib/tools/search.ts:304-389`) with a
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
  `lib/streaming/create-chat-stream-response.ts:426` already strips earlier turns' crawled pages
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

### D20. Narration strippers: strict at persist, best-effort live

- **Status:** adopted · **Dates/commits:** `378e81af` (2026-09-10), `0290896c` (2026-09-17);
  earlier `f4c53a7a` (2026-07-08)
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
- **Consequences.**
  - Already-saved leaked messages stay leaked until regenerated. The strippers act at persist time.
  - Residual by design: a final answer with fused narration and **no** `##` heading is left intact
    (rare, since prompts mandate the heading). Dropping it risks losing real content.
  - The rule "the answer is the text after the last tool part" is also used by
    `lib/memory/extract-indexable-text.ts`.
- **Revisit if** a new narration family appears. Add its starters and tests
  (`lib/streaming/helpers/__tests__`); don't loosen the structural thresholds without a corpus.

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
  inside the `/api/apply` handler (`ac437a2b`). Some newer knobs (for example the `UPLOADS_*` ones)
  may not yet be in its env schema *(unverified)*.
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
  the persisted conversation. `metadata.stopped` is set but **not rendered** (see
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
