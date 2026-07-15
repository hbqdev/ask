# Search Fine-Tuning Across Modes — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Component:** Ask web-search pipeline (SearXNG + degoog)

## Goal

Make Ask's multi-search research turns use SearXNG and degoog more
effectively and cheaply, across all three modes (speed / balanced /
quality), by adding three independent, composable levers:

1. **Query-intent engine routing** — auto-detect the turn's intent and
   *add* intent-specific SearXNG engines on top of the always-on general
   baseline, instead of every search hitting the same fixed
   `google,bing,duckduckgo,wikipedia` set.
2. **Depth tiering** — within one turn, only the first search runs
   *advanced* (crawl + rerank); follow-up searches run *basic* (snippets),
   with the existing `fetch` tool as the on-demand deep-read escape hatch.
   Cuts the 5–15× crawl cost of exploratory follow-up searches.
3. **Search-intent dedup** — skip near-duplicate query reformulations
   within a turn using the local embedding pipeline, so the model doesn't
   burn a full search+crawl+rerank cycle on a query it effectively already
   ran.

Each lever is independently valuable, independently toggleable, and fails
safe (a lever failure degrades to exactly today's behavior). They share no
state except the per-turn search-tool closure.

## Background: current behavior

- A per-turn classifier (`lib/agents/query-classifier.ts`, granite4.1:8b on
  serenity) already resolves `{skipSearch, standaloneQuery, needsRecent}`
  before the researcher runs. This spec extends its schema with `intent`.
- The researcher (`lib/agents/researcher.ts`) is a `ToolLoopAgent` that may
  call the `search` tool many times per turn (balanced maxSteps 50, quality
  maxSteps 100). Multiple searches per turn are by design — the levers make
  each search cheaper and better-targeted, they do **not** cap the count.
- `createSearchTool(model, toolOptions)` (`lib/tools/search.ts`) is
  constructed **once per turn** inside `createResearcher`, so its closure is
  the natural home for per-turn state. It already holds one such flag
  (`expansionUsed`). Levers 2 and 3 add more.
- Two SearXNG code paths exist and **both** must be updated for intent
  routing:
  - **basic** path: `lib/tools/search/providers/searxng.ts` (`else` branch,
    the non-academic/non-social case) — builds `categories` +
    `engines`, **merges degoog** (web/images, + video/news on demand).
  - **advanced** path: `app/api/advanced-search/route.ts`
    (`advancedSearchXNGSearch`) — separate SearXNG query + crawl + rerank,
    uses `SEARXNG_ENGINES` env and `categories=general,images`. **Does NOT
    query degoog today** — SearXNG-only (see "degoog parity" below).
- `SEARXNG_DEFAULT_DEPTH` is unset in prod (defaults `basic`). Depth is
  therefore **model-controlled** today: a search runs advanced only when the
  model passes `search_depth: 'advanced'`. The balanced/quality mode prompts
  push the model toward advanced, which is why those modes issue several
  advanced (expensive) searches per turn.

### Verified SearXNG semantics (live instance, search.hbqnexus.win)

Empirically confirmed against the live instance — the basis for the
"additive" design:

- `engines=github,stackoverflow` (no categories) → **only** those engines
  fire.
- `categories=it` (no engines) → **all** enabled `it` engines fire
  (github, stackoverflow, mdn, docker hub, lobste.rs, hackernews…).
- `categories=general,it` **+** `engines=google,bing` → **union**: general
  engines *and* it engines both fire.

**Conclusion:** appending a category to the `categories` param is purely
additive and coexists with a pinned `engines` list. Intent routing is
therefore a one-category append — no engine-list surgery, no risk of the
intent replacing the general baseline.

## SearXNG configuration changes (DONE)

Already applied and both instances restarted — documented here for
completeness:

- **Primary** (`runtipi/app-data/migrated/searxng/data/settings.yml`,
  search.hbqnexus.win): enabled `bing`, `hackernews`, `lobste.rs`.
- **Local fallback** (`ask/searxng-settings.yml`): enabled `hackernews`,
  `lobste.rs` (mirrors primary for the `it`/`social media` categories).
- **Reddit stays out of SearXNG** — SearXNG's reddit engine is blocked
  (OAuth-gated, "Suspended: access denied"). Reddit coverage comes from
  degoog + general engines that index reddit.com, exactly as before degoog
  was wired. No further SearXNG reddit work.

No further config changes are required for the levers below.

---

## Lever 1: Query-intent engine routing (additive)

### Model

Auto-detected intent is **additive**: the general baseline engines are
**always** queried, and the intent's engines are **added** on top
(`general + intent`). A mis-detected or narrow intent can therefore never
starve the result set — it can only add specialized depth. Latency cost is
negligible: SearXNG queries engines in parallel (max, not sum), and the
downstream reranker sorts mainstream-vs-specialized relevance regardless.

This is distinct from the **user-selected** Academic/Social modes
(`wrapSearchToolForSources`, the `isAcademic`/`isSocial` branches), which
stay **exclusive** (science-only / social-only). Rationale: an automatic
guess should be additive (safe); a deliberate user choice should be focused
(filter the noise). Lever 1 touches **only** the general `else` branch, never
those two branches.

### Intent taxonomy → SearXNG category

Five intents. Each maps to at most one added category (verified to union
with the general baseline):

| Intent       | Added category | Engines it brings                                        |
|--------------|----------------|----------------------------------------------------------|
| `general`    | *(none)*       | baseline only                                            |
| `code`       | `it`           | github, stackoverflow, mdn, pypi, npm, docker hub, …     |
| `discussion` | `social media` | hackernews, lobste.rs, lemmy, mastodon (+ degoog reddit) |
| `news`       | `news`         | google news, bing news, … (pairs with `needsRecent`)     |
| `academic`   | `science`      | arxiv, pubmed, scholar, semantic scholar, crossref, …    |

Notes:
- "docs" from the original brainstorm is folded into `code` — both route to
  the `it` category, so a separate intent would be routing-identical
  (YAGNI). The classifier prompt tells it to use `code` for library/API/docs
  questions too.
- `code`/`discussion`/`news` overlap with the model-controllable
  `content_types` field (which already appends `it`/`news` categories). That
  is intentional: Lever 1 is the **automatic safety net** (turn-level, from
  the classifier) so correct routing doesn't depend on the model choosing
  `content_types` well. Both mechanisms append categories and compose
  cleanly (union).
- `academic` **auto-intent** is additive (`general + science`) and is a
  different thing from the user-selected Academic mode (exclusive science).

### Classifier changes (`lib/agents/query-classifier.ts`)

- Add `intent` to `classifierSchema` and `QueryClassification`:
  `z.enum(['general','code','discussion','news','academic'])`.
- Extend `CLASSIFIER_SYSTEM_PROMPT` with intent rules + 1 example per
  intent. Rule: **default to `general` on any uncertainty** — additive
  routing makes a wrong `general` harmless (baseline still fires), so the
  classifier is instructed to only leave `general` when the intent is
  clear.
- `fallback` (classifier failure/timeout) sets `intent: 'general'`, matching
  today's behavior exactly.
- The added field must not degrade `skipSearch`/`needsRecent` accuracy —
  validated during implementation against the existing live test cases plus
  new per-intent cases.

### Plumbing

`classification.intent` threads through the existing chain, mirroring how
`needsRecent`/`timeRange` already flows:

1. `create-chat-stream-response.ts` & `create-ephemeral-chat-stream-response.ts`
   → pass `intent: classification.intent` to `researcher()`.
2. `createResearcher` → accept `intent`, pass it into
   `createSearchTool(model, { …, intent })`.
3. `SearchToolOptions` gains `intent?: SearchIntent`. The tool passes it to:
   - the **basic** path: `searxng` provider `options.intent`.
   - the **advanced** path: the `/api/advanced-search` POST body
     (`intent` field).
4. **basic** — `searxng.ts` `else` branch: map `intent → category` and push
   onto the existing `['general','images', ...extraCategories]` list. One
   added line in the category assembly; nothing else changes. Academic/social
   branches untouched.
5. **advanced** — `advanced-search/route.ts`: read `intent` from the body,
   map to a category, and append it to the `categories=general,images`
   param in `advancedSearchXNGSearch` (thread `intent` through the function
   signature + cache key).

A shared `INTENT_TO_CATEGORY` map + `SearchIntent` type lives in one module
(e.g. alongside the searxng provider's category maps) and is imported by
both paths — single source of truth, no drift.

---

## Lever 2: Depth tiering

### Behavior

Per turn:
- **First search** → advanced (crawl + rerank) in balanced/quality; basic in
  speed (unchanged).
- **All subsequent searches** → forced basic (snippets), regardless of the
  model's requested `search_depth`.
- **Escape hatch** — the model already has the `fetch` tool. To deep-read a
  specific promising snippet from a follow-up search, it fetches that URL
  (cheap, targeted) instead of re-running an advanced crawl over a whole
  result set. The mode prompts gain one line teaching this pattern.

This caps expensive crawl+rerank to **once per turn** while preserving deep
grounding on the primary query and unlimited cheap breadth afterward.

### Implementation (`lib/tools/search.ts`)

- `SearchToolOptions` gains `firstSearchDepth?: 'basic' | 'advanced'`, set by
  the mode in `createResearcher`:
  - speed → `'basic'` (no behavior change).
  - balanced / quality → `'advanced'`.
  - skipSearch turn → `'basic'` (escape-hatch searches stay cheap).
- Add a closure flag `firstSearchDone = false` (sibling of `expansionUsed`).
- Depth resolution, replacing the current `effectiveSearchDepthForAPI`
  computation:
  - Search #1 of the turn → use `firstSearchDepth` (advanced for deep modes).
  - Search #2+ → force `'basic'`, overriding the model's `search_depth`.
  - Set `firstSearchDone = true` after the first search resolves its depth.
- Speed mode is unaffected: `firstSearchDepth='basic'` means every search,
  including the first, stays basic.
- Feature toggle: `SEARCH_DEPTH_TIERING` env (default on). When off, depth is
  computed exactly as today (model/env-driven), so the lever can be disabled
  without a redeploy.

### Prompt change (`lib/agents/prompts/search-mode-prompts.ts`)

Add to the balanced + quality prompts: a short note that the first search is
deep (crawled + reranked) and later searches return snippets, and that to
read a specific promising result in full the model should call `fetch` on its
URL rather than re-searching for depth.

### degoog parity on the advanced path (required)

Both search paths must query **SearXNG + degoog** — that is the intended
source breadth for the general path (and every intent). The **basic** path
already does. The **advanced** path (`/api/advanced-search`) is SearXNG-only
today, and depth tiering routes the turn's *first, deepest* search there —
so without this fix, the single most important search of the turn loses all
degoog coverage. That regression is unacceptable, so this fix ships with the
levers.

Change (`app/api/advanced-search/route.ts`, `advancedSearchXNGSearch`):
- Query degoog concurrently with the SearXNG call (reuse `fetchDegoogJson` +
  the merge helpers already used by the basic provider), degrading
  gracefully exactly as the basic path does (degoog is a complement:
  `null`/failure → SearXNG-only, never fails the search).
- Merge degoog **web** results into the SearXNG result set **before** the
  crawl + rerank stage, so degoog URLs are also candidates for crawling and
  for the cross-encoder rerank — not appended after. Merge degoog **images**
  into the returned images. Request degoog **news** when `intent='news'`
  (mirrors the basic path's on-demand news fetch).
- Keep the existing dedup/merge semantics (`mergeWithDegoogResults` etc.) so
  the two paths return structurally identical, deduped result sets.

This makes the deep first search and the cheap follow-up searches
source-symmetric: same engines (general baseline + intent category) and the
same SearXNG+degoog union on both.

---

## Lever 3: Search-intent dedup

### Behavior

Within a turn, before executing a search, compare the incoming (resolved)
query against the queries already executed this turn using the local
embedding pipeline. If cosine similarity to any prior query exceeds a
threshold (default ~0.92), **skip** the expensive search and return a short
note instead of results.

The prior search's results are **already in the model's context** (from the
earlier tool call), so re-sending them is unnecessary — the skip note tells
the model to reuse them or refine to a materially different angle.

### Implementation (`lib/tools/search.ts`)

- Closure state (per turn): `executedQueries: string[]` and
  `executedQueryEmbeddings: number[][]`, keyed within a `search_mode` so a
  web search and an academic search of the same words aren't treated as
  duplicates.
- On each `execute`:
  1. Embed the resolved query with `embedTexts([query])`
     (`lib/embeddings/transformers-embedding.ts`, local MiniLM, already
     used — ~tens of ms for one short string; negligible vs a search).
  2. Compute max `cosineSimilarity` against `executedQueryEmbeddings` for the
     same mode.
  3. If `max > SEARCH_DEDUP_THRESHOLD` → **skip**: yield
     `{ state:'complete', results:[], images:[], query, note }` where `note`
     names the near-duplicate prior query and its score and instructs the
     model to reuse the earlier results or search a materially different
     angle. Surface `note` in `toModelOutput` so the model sees it.
  4. Else → record the query + embedding and execute normally.
- The **first** search of a turn never dedups (nothing prior). Expansion
  variants (existing feature, run *inside* the first search) are unaffected —
  dedup guards the model's successive top-level `search` calls, not the
  expansion fan-out.
- Interaction with `wrapSearchToolWithDedup` (URL-level dedup in
  `researcher.ts`): that wrapper sits *outside* `createSearchTool` and
  strips already-seen URLs. Query-level dedup sits *inside* and short-circuits
  before the network call. They are complementary (query-level avoids the
  fetch entirely; URL-level trims overlap when two distinct queries return
  overlapping links).
- Feature toggle: `SEARCH_DEDUP_ENABLED` (default on),
  `SEARCH_DEDUP_THRESHOLD` (default `0.92`). When off, every search executes,
  exactly as today.

---

## Cross-cutting: tuning knobs (env)

| Env var                  | Default | Lever | Effect                                             |
|--------------------------|---------|-------|----------------------------------------------------|
| `SEARCH_DEPTH_TIERING`   | on      | 2     | Off → today's model/env-driven depth per search.   |
| `SEARCH_DEDUP_ENABLED`   | on      | 3     | Off → never skip near-duplicate searches.          |
| `SEARCH_DEDUP_THRESHOLD` | `0.92`  | 3     | Cosine cutoff; higher = stricter (fewer skips).    |

Lever 1 has no toggle — additive routing is strictly safe (baseline always
fires); `intent='general'` is already the no-op case.

## Data flow (one balanced turn)

```
user msg
  └─ classifyQuery → { skipSearch, standaloneQuery, needsRecent, intent }   (Lever 1 source)
       └─ researcher(intent, needsRecent, firstSearchDepth='advanced', …)
            └─ createSearchTool closure: { expansionUsed, firstSearchDone,
                                           executedQueries[], executedQueryEmbeddings[] }
                 ├─ search #1: dedup(miss) → depth=advanced → /api/advanced-search
                 │              searxng+degoog, categories=general,images,<intent>
                 │              (merge → crawl → rerank)                             [Levers 1+2]
                 ├─ search #2: dedup(miss) → depth=basic  → searxng provider
                 │              searxng+degoog, categories=general,images,<intent>
                 │              (snippets)                                           [Levers 1+2]
                 ├─ search #3: dedup(HIT ≥0.92) → skip, return note                  [Lever 3]
                 └─ fetch(url): on-demand deep-read of a snippet                     [Lever 2 escape]
```

## Failure modes (all degrade to today's behavior)

- Classifier fails/times out → `intent='general'`, `needsRecent=false`,
  always-search (unchanged fallback).
- Intent category mis-detected → additive, so baseline still fires; worst
  case is a few extra specialized results the reranker down-ranks.
- Embedding call fails in Lever 3 → treat as "not a duplicate", execute the
  search (no worse than today).
- Any lever toggled off via env → that lever is a no-op; the others still
  apply.

## Testing / verification

Unit / integration (Vitest, `bun run test`):
- Classifier: intent field parses; fallback sets `intent='general'`; the new
  field doesn't regress existing `skipSearch`/`needsRecent` cases.
- `INTENT_TO_CATEGORY` mapping + category assembly in both the basic provider
  and the advanced route (correct category appended; academic/social branches
  untouched; `general` intent appends nothing).
- Depth tiering: first search advanced, subsequent forced basic; speed
  unchanged; toggle off restores prior logic.
- Dedup: near-duplicate skipped with note; distinct queries execute;
  different `search_mode` not cross-deduped; first search never skipped;
  toggle off disables.

Live (staging ask-admin-feature :3739, then production per the standard
merge→push→rebuild flow):
- A code query auto-routes to `it` engines *in addition to* general (verify
  engine mix in results / logs).
- A balanced multi-search turn runs exactly one advanced search, the rest
  basic (verify via `/api/advanced-search` call count / logs).
- The advanced (first) search now includes degoog results in its crawl+rerank
  candidate set (verify degoog URLs appear among advanced results / logs), so
  it's source-symmetric with the basic follow-up searches.
- A turn where the model reformulates a near-identical query shows a dedup
  skip in logs and the model proceeds without a redundant crawl.
- Academic/Social user-selected modes still behave exclusively (unchanged).

## Out of scope

- Capping the number of searches per turn (multi-search is by design).
- Changing the user-selected Academic/Social exclusive modes.
- Any new SearXNG engine work (reddit stays with degoog + general engines).
- Reranker/embedding model changes (existing cross-encoder + MiniLM reused
  as-is).
- Per-search intent chosen by the model (intent is turn-level from the
  classifier; the model's existing `content_types`/`search_mode` remain its
  per-search controls and compose additively).
```

