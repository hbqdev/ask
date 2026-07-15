# Ollama Web Search — Design Spec

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Component:** Ask web-search pipeline (adds a hosted complementary source)

## Goal

Add Ollama's hosted web search API as an **always-on complementary source** in
Ask's search pipeline, for two reasons:

1. **Resilience** — the query runs on Ollama's servers, so it egresses from
   Ollama's IPs, not our (intermittently IP-blocked) residential Comcast IP. It
   is immune to the DuckDuckGo/Startpage/Brave-style blocking that hits our
   self-hosted engines.
2. **Richer content** — Ollama returns **full page content** per result, not
   just a snippet, so on the deep search it can feed the reranker and the model
   directly, skipping a Crawl4AI fetch.

Ollama is **extra on top**, never a replacement: searxng + degoog remain the
base; Ollama is merged in alongside them and composes with the existing intent
routing, depth tiering, search-intent dedup, and cross-encoder rerank.

## Background: current pipeline

- `createSearchTool` (`lib/tools/search.ts`) is built once per turn; its closure
  holds per-turn state (`expansionUsed`, `firstSearchDone`, `executedQueries`).
- Two search paths, both of which already query degoog as a graceful complement:
  - **basic** — `lib/tools/search/providers/searxng.ts` (`else` branch):
    searxng + degoog via `Promise.allSettled`, merged into snippet results.
  - **advanced** — `app/api/advanced-search/route.ts`
    (`advancedSearchXNGSearch`): searxng + degoog → merge candidate pool →
    Crawl4AI enrich → cross-encoder rerank → return.
- **degoog client** (`lib/utils/degoog-client.ts`) is the reference pattern:
  returns `null` when `DEGOOG_API_URL` unset, throws on real failure, has a
  request timeout + a circuit-breaker cooldown (`downUntil`).
- **Depth tiering** makes the FIRST search of a balanced/quality turn advanced
  (crawl+rerank) and follow-ups basic (snippets).

### Ollama web search API (verified live)

- `POST https://ollama.com/api/web_search`, header `Authorization: Bearer <key>`,
  body `{"query": "...", "max_results": N}` → `{"results":[{"title","url","content"}]}`.
- Verified: HTTP 200 in ~0.9s, 3 results, each with full page content
  (2K–35K chars). Maps 1:1 onto Ask's `SearchResultItem {title, url, content}`.
- The key is the Ollama **cloud** key (the local signed-in Ollama does NOT
  expose `/api/web_search` — confirmed 404). Reuse the existing key currently
  configured for the MCP wrapper.

---

## Components

### 1. Ollama search client — `lib/utils/ollama-search-client.ts` (new)

Mirrors `degoog-client.ts`:

- `isOllamaSearchConfigured(): boolean` — true when `OLLAMA_SEARCH_API_KEY` is
  set. The whole feature is inert otherwise (same pattern as degoog/reranker).
- `fetchOllamaSearch(query: string, maxResults: number, opts?: { timeoutMs?: number }): Promise<OllamaSearchResult[] | null>`
  - Returns `null` when unconfigured (callers treat Ollama as optional).
  - `POST https://ollama.com/api/web_search` with Bearer auth, body
    `{ query, max_results: maxResults }`. Parses `{results:[{title,url,content}]}`.
  - Throws on network/timeout/non-OK so callers can degrade (mirrors
    `fetchDegoogJson`'s contract).
  - Request timeout (default `OLLAMA_SEARCH_TIMEOUT_MS`, ~10s) via
    `AbortController`, plus a circuit-breaker cooldown (`downUntil`,
    `BREAKER_COOLDOWN_MS` ~30s) so an Ollama outage doesn't tax every search.
- `OllamaSearchResult` type: `{ title: string; url: string; content: string }`.

### 2. Merge helper — `lib/tools/search/providers/merge-ollama.ts` (new)

Next to `merge-degoog.ts`, reusing its normalize/dedup approach:

- `mergeOllamaIntoSearxngResults(searxngResults: SearXNGResult[], ollamaResults: OllamaSearchResult[], maxResults: number): SearXNGResult[]`
  — converts Ollama results to `SearXNGResult` shape carrying their **full**
  content, deduped by normalized URL against the existing list, capped. Used by
  the **advanced** path (content feeds the reranker + model).
- `mergeOllamaIntoResults(items: SearchResultItem[], ollamaResults: OllamaSearchResult[], maxResults: number, maxContentChars: number): SearchResultItem[]`
  — converts Ollama results to `SearchResultItem` with content **truncated** to
  `maxContentChars` (default `OLLAMA_BASIC_SNIPPET_CHARS`, ~400) so basic-path
  results stay snippet-uniform. Used by the **basic** path.

### 3. Per-turn budget (B+A) — `lib/tools/search.ts`

- Closure adds `let ollamaCallsUsed = 0` (sibling of `firstSearchDone`).
- After the dedup gate and once this search is committed to executing, compute:
  ```ts
  const ollamaEnabled =
    isOllamaSearchConfigured() && process.env.OLLAMA_SEARCH_ENABLED !== 'off'
  const isFirstSearchOfTurn = !firstSearchDone // captured before firstSearchDone flips
  const maxPerTurn = Number(process.env.OLLAMA_SEARCH_MAX_PER_TURN ?? '5')
  const useOllama =
    ollamaEnabled &&
    (isFirstSearchOfTurn || ollamaCallsUsed < (Number.isFinite(maxPerTurn) ? maxPerTurn : 5))
  if (useOllama) ollamaCallsUsed++
  ```
  So the **first** search of the turn always includes Ollama (guaranteed B),
  and **follow-ups** include it until `OLLAMA_SEARCH_MAX_PER_TURN` (capped A).
  A dedup-skipped search returns before this point and never consumes budget.
- `search.ts` passes `useOllama` (and `ollamaMaxResults`) down to whichever path
  runs:
  - **advanced**: added to the `/api/advanced-search` POST body.
  - **basic**: added to the searxng provider `options`.

### 4. Advanced-path integration — `app/api/advanced-search/route.ts`

- Read `useOllama` / `ollamaMaxResults` from the POST body; thread into
  `advancedSearchXNGSearch`.
- When `useOllama`: add `fetchOllamaSearch(query, ollamaMaxResults)` to the
  existing `Promise.allSettled([searxng, degoog…])`, degrading gracefully
  (rejection/`null` → `[]`, never fails the search).
- Merge Ollama results into `generalResults` **after** the degoog merge and
  **before** the `if (searchDepth === 'advanced')` crawl block, via
  `mergeOllamaIntoSearxngResults` (full content).
- **Skip Crawl4AI for Ollama URLs** — build
  `const prefetchedUrls = new Set(ollamaResults.map(r => r.url))`:
  - `toEnrich` (the Crawl4AI batch) excludes prefetched URLs:
    `candidates.filter(r => !prefetchedUrls.has(r.url)).slice(0, MAX_ENRICH_URLS)`.
  - In the per-candidate crawl step, a prefetched URL keeps its own content
    (apply the same `highlightQueryTerms(...substring(0,10000))` treatment as a
    crawled result, so it's consistent) instead of calling `crawlPage`.
  - So Ollama's content flows straight into the cross-encoder rerank and
    competes fairly with crawled searxng/degoog content; no re-fetch.
- Add `useOllama`/`ollamaMaxResults` to the Redis cache key so an Ollama-included
  result isn't served for a non-Ollama request and vice versa.

### 5. Basic-path integration — `lib/tools/search/providers/searxng.ts`

- Add `useOllama?: boolean` and `ollamaMaxResults?: number` to the provider
  `options` (and to `SearchProviderOptions` in `base.ts`).
- When `useOllama`: add `fetchOllamaSearch` to the existing `Promise.allSettled`
  with searxng + degoog; on success, merge via `mergeOllamaIntoResults`
  (snippet-truncated). Graceful degradation identical to degoog.

---

## Data flow (one balanced turn)

```
Search #1 (advanced, useOllama=true):
  searxng + degoog + OLLAMA  ─merge→  candidate pool
     ├─ searxng/degoog URLs → Crawl4AI enrich
     └─ OLLAMA URLs → skip crawl, keep their full content
  → cross-encoder rerank over ALL (crawled + Ollama)  → return

Search #2..N (basic, useOllama=true until cap):
  searxng + degoog + OLLAMA(content truncated to ~400 chars)  ─merge→  snippets → return

Beyond OLLAMA_SEARCH_MAX_PER_TURN:
  searxng + degoog only (Ollama omitted)
```

## Error handling

Ollama is a pure complement, identical to degoog:
- Unconfigured (`OLLAMA_SEARCH_API_KEY` unset) → `fetchOllamaSearch` returns
  `null` → path proceeds on searxng+degoog. Feature inert.
- Timeout / non-OK / rate-limit → throws → caught by `Promise.allSettled` →
  path continues without Ollama. Circuit breaker suppresses repeated attempts
  during an outage.
- `OLLAMA_SEARCH_ENABLED=off` → disabled regardless of key.
- Never fails or delays a search beyond its own timeout.

## Config (env)

| Env var | Default | Effect |
|---|---|---|
| `OLLAMA_SEARCH_API_KEY` | *(unset)* | Ollama cloud key. **Enables** the feature; reuse the existing key. |
| `OLLAMA_SEARCH_ENABLED` | on | Only `'off'` disables (kill switch). |
| `OLLAMA_SEARCH_MAX_PER_TURN` | `5` | Per-turn cap on Ollama calls (first search always + follow-ups until cap). |
| `OLLAMA_SEARCH_MAX_RESULTS` | `5` | `max_results` per Ollama call. |
| `OLLAMA_SEARCH_TIMEOUT_MS` | `10000` | Per-request timeout. |

`OLLAMA_SEARCH_API_KEY` is distinct from `OLLAMA_BASE_URL` (the local Ollama for
models) — web search is the cloud endpoint and needs the cloud key in Ask's
`.env`.

## Testing

Unit (Vitest, `bun run test`):
- `ollama-search-client`: returns `null` unconfigured; parses `{results}` on
  success; throws on non-OK/timeout; circuit-breaker suppresses during cooldown.
- `merge-ollama`: Ollama → `SearXNGResult`/`SearchResultItem` shape; dedup by
  normalized URL; content truncation on the basic helper; full content on the
  advanced helper.
- Per-turn budget: first search always `useOllama=true`; follow-ups until the
  cap then `false`; dedup-skipped searches don't consume budget;
  `OLLAMA_SEARCH_ENABLED=off` and unset key both disable.

Live (staging ask-admin-feature :3739, then production per the standard
merge→push→rebuild flow):
- With the key set, a balanced turn's results include Ollama-sourced URLs.
- Advanced-search logs show Crawl4AI enriching only searxng/degoog URLs (Ollama
  URLs skipped) while Ollama content still appears in the reranked output.
- Graceful degradation: unset key → searxng+degoog only, no errors; simulated
  Ollama failure → search still returns.

## Out of scope

- Replacing searxng/degoog with Ollama (it's additive only).
- Using Ollama's `web_fetch` endpoint (the search endpoint already returns
  content; a separate fetch-tool integration is a future consideration).
- Routing the local Ollama through the cloud search (not supported — 404).
- Changing intent routing, depth tiering, dedup, or the reranker (Ollama plugs
  into the existing pipeline unchanged).
