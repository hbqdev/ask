# Accuracy improvements: fetch rescue chain, recency, query expansion, reranking

**Date:** 2026-07-14
**Status:** Approved (user), pending implementation plan
**Goal:** Close Ask's remaining accuracy gap to Perplexity by eliminating the
worst-case answer tail: failed/thin page fetches, stale answers to
time-sensitive questions, single-phrasing discovery misses, and
keyword-matched (rather than semantically relevant) evidence selection.

## Context

- Search: self-hosted SearXNG (`SEARCH_API=searxng`) merged with degoog;
  advanced mode self-crawls result pages (`crawlPage` in
  `app/api/advanced-search/route.ts`) with regex text extraction and a
  keyword-count relevance scorer.
- Fetch tool (`lib/tools/fetch.ts`): "regular" = plain HTTP + regex
  stripping (bot-blocked and JS-blind); "api" = Jina/Tavily, **both keys
  absent in this deployment, so it silently fails**. YouTube transcripts
  and upload-PDF RAG already work.
- Firecrawl: client + search provider exist in-tree but are dormant.
  `FIRECRAWL_API_KEY` is set. Budget: **free tier, ~500 one-time credits**
  → Firecrawl must be a surgical last resort, never a backbone.
- Free assets already deployed: flaresolverr container (degoog stack,
  loopback-bound on host), `pdftotext` in the app image, local
  transformers embedding pipeline (`lib/embeddings/`), jsdom dependency,
  per-turn query classifier on serenity GPU (granite4.1:8b).

## Workstream 1 — Fetch rescue chain (Firecrawl where it's really needed)

New shared extraction helper `lib/utils/extract-content.ts`:
HTML → jsdom + `@mozilla/readability` (new dependency) → clean article
text; falls back to the existing regex stripping when Readability finds no
article node. Used by both the fetch tool and advanced-search `crawlPage`.

Fetch chain, ordered by cost:

1. **Regular fetch + Readability** (free). A fetch counts as failed when:
   HTTP error after existing retries, unsupported content type, or
   extracted text < ~200 chars (catches JS shells that 200 with nothing).
2. **flaresolverr** (free, already running). Handles Cloudflare/bot walls.
   The `ask` container joins the degoog Docker network to reach it
   (it is loopback-bound on the host). Same failure criteria.
3. **Firecrawl `/scrape`** (1 credit, true last resort — JS-heavy SPAs,
   stubborn blocks). Hard timeout; every call logs a credit-spend line so
   burn rate is visible in container logs.
4. Existing "Fetch failed" placeholder.

PDF URLs: download + local `pdftotext` first (free, same binary the upload
flow uses); Firecrawl only if that fails. The "api" fetch type is
repointed at this chain. The Jina/Tavily extract functions stay in the
file and slot in between flaresolverr and Firecrawl **only when their API
key is present** (absent in this deployment, so they are inert here).

## Workstream 2 — Recency flag on the classifier

Extend the per-turn classifier schema (`lib/agents/query-classifier.ts`)
with `needsRecent: boolean` — true when the answer depends on current or
recent information (news, prices, versions, "latest X", schedules).
Prompt gains rules + examples; temperature stays 0. The flag plumbs
through the researcher into the search tool and sets SearXNG's
`time_range` (e.g. `year` or `month`) for that turn's searches, in both
the provider and the advanced-search route. Validated against
granite4.1:8b with an extended version of the existing 8-case suite.

## Workstream 3 — Multi-query expansion

New small agent (same pattern/host as the classifier — serenity,
granite4.1:8b, structured output, strict timeout, graceful fallback to
no-expansion): given the classifier's standalone query + brief context,
emit 2–3 diverse reformulations (synonyms, entity expansion, alternative
framings). All variants search in parallel; results merge with the
existing URL-dedup wrapper. Balanced/Quality modes only (Speed stays
single-query for latency). Expansion runs concurrently with other
per-turn prep, mirroring the classifier's parallel-kickoff pattern.

## Workstream 4 — Semantic reranking in advanced search

In `advancedSearchXNGSearch` after crawling: split each page into
passages (`lib/embeddings/split-text.ts`), embed query + passages with the
existing local pipeline (`lib/embeddings/transformers-embedding.ts`,
already lazy-loaded + disk-cached), cosine-rank, keep top passages per
result, reorder results by best-passage score. Replaces the keyword
`calculateRelevanceScore`. Advanced mode only; model is warm after first
use.

## Workstream 5 — Corroboration prompting

Balanced/Quality prompts: key factual claims should be supported by two
independent sources when available; genuine source disagreements are
surfaced explicitly rather than averaged away. Prompt-only change.

## Explicitly out of scope

- Firecrawl as search provider / `/crawl` / `/map` (credit burn, no case).
- Claim-verification pass (extract draft claims, entailment-check against
  fetched passages via serenity model) — **held as its own follow-on
  project** once the post-implementation error profile is visible.
- Swapping SearXNG or the answering models.

## Follow-on research (after implementation)

Self-hosted Firecrawl alternatives — Crawl4AI (lead candidate:
LLM-ready markdown, self-hosted, Playwright-based rendering), Crawlee,
Scrapy, ScrapeGraphAI, raw Playwright. Key question: with unmetered
self-hosted scraping, enable full-content enrichment of top-N results on
every research turn (the "backbone" approach cut for credit reasons), and
possibly retire the Firecrawl rescue tier entirely.

## Error handling & testing

- Every new external hop (flaresolverr, Firecrawl, expansion agent) is
  timeout-bounded and falls back to the next tier / no-op; a total
  failure of everything new leaves behavior identical to today.
- Unit tests: extraction helper (Readability + fallback), chain ordering
  on simulated failures, classifier schema extension, expansion merge +
  dedup, reranker ordering.
- Live validation: scripted classifier/expansion runs against serenity;
  Playwright UI passes for a blocked-page fetch, a PDF URL fetch, a
  recency-sensitive query, and a Quality-mode research turn.

## Rollout order

1. WS1 (rescue chain + Readability) — kills the observed failure class,
   makes credits last.
2. WS2 (recency flag) — smallest change, big stale-answer win.
3. WS3 (query expansion).
4. WS4 (reranking).
5. WS5 (corroboration prompting) — alongside or after WS3/4.

Each workstream ships independently (test → staging container → verify →
production), matching the repo's existing release flow.
