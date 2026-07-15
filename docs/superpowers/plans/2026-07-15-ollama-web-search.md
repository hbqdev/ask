# Ollama Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Ollama's hosted web search as an always-on complementary source in Ask's search pipeline (resilience against IP-blocked engines + richer full-content results), merged alongside searxng+degoog.

**Architecture:** A degoog-style client (`ollama-search-client.ts`) calls `https://ollama.com/api/web_search`. The search tool sets a `useOllama` flag per executing search and passes it to both search paths. The basic path merges Ollama results as snippet-truncated items; the advanced path merges Ollama's full content into the rerank candidate pool and skips Crawl4AI for those URLs (they're already fetched). Pure complement — fails safe to searxng+degoog.

**Tech Stack:** Next.js 16 / React 19, Vercel AI SDK, TypeScript, Vitest, Ollama cloud web search API.

## Global Constraints

- **Additive only:** Ollama never replaces searxng/degoog — it's merged in alongside. Feature is INERT unless `OLLAMA_SEARCH_API_KEY` is set (mirror degoog/reranker gating).
- **No per-turn cap:** when enabled, Ollama runs on EVERY executing search of the turn. A dedup-skipped search returns before the Ollama call and never invokes it.
- **Fail-safe:** Ollama is a pure complement — timeout/error/rate-limit/unconfigured ⇒ continue on searxng+degoog, never fail or block a search. Circuit-breaker cooldown like degoog.
- **Skip Crawl4AI for Ollama URLs (advanced path):** Ollama results already carry full content; they must NOT be re-crawled — they feed the reranker directly via a `prefetchedUrls` set.
- **Env (exact names/defaults):** `OLLAMA_SEARCH_API_KEY` (enables feature), `OLLAMA_SEARCH_ENABLED` (default on, only `'off'` disables), `OLLAMA_SEARCH_MAX_RESULTS` (default `5`), `OLLAMA_SEARCH_TIMEOUT_MS` (default `10000`). Basic-path content truncation constant `OLLAMA_BASIC_SNIPPET_CHARS` ≈ 400. `OLLAMA_SEARCH_API_KEY` is the Ollama CLOUD key, distinct from `OLLAMA_BASE_URL`.
- **Testing:** `bun run test` (NOT `bun test`). Pre-commit: `bun lint --fix`, `bun typecheck`, `bun format` on touched files. Branch has ~pre-existing typecheck/lint issues in UNRELATED files — add no new ones in touched files. Commit on `admin-feature`; do NOT push/redeploy until final verification.

---

## File Structure

- **Create** `lib/utils/ollama-search-client.ts` — client (`isOllamaSearchConfigured`, `fetchOllamaSearch`, `OllamaSearchResult` type). Mirrors `degoog-client.ts`.
- **Create** `lib/tools/search/providers/merge-ollama.ts` — `mergeOllamaIntoSearxngResults` (full content, advanced) + `mergeOllamaIntoResults` (truncated, basic).
- **Modify** `lib/tools/search/providers/merge-degoog.ts` — `export` the internal `normalizeUrl` for reuse.
- **Modify** `lib/tools/search.ts` — compute `useOllama`/`ollamaMaxResults`, pass to both paths.
- **Modify** `lib/tools/search/providers/base.ts` — `SearchProviderOptions` gains `useOllama?`/`ollamaMaxResults?`.
- **Modify** `lib/tools/search/providers/searxng.ts` — basic path fetch + merge Ollama.
- **Modify** `app/api/advanced-search/route.ts` — advanced path fetch + merge + skip-crawl + cache key.
- **Modify** `.env.local.example` — document the new env vars.

---

## Task 1: Ollama search client

**Files:**
- Create: `lib/utils/ollama-search-client.ts`
- Create: `lib/utils/__tests__/ollama-search-client.test.ts`

**Interfaces:**
- Produces: `OllamaSearchResult` (`{title, url, content}`); `isOllamaSearchConfigured(): boolean`; `fetchOllamaSearch(query, maxResults, opts?): Promise<OllamaSearchResult[] | null>` (null when unconfigured, throws on failure).

- [ ] **Step 1: Write the failing test**

Create `lib/utils/__tests__/ollama-search-client.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  fetchOllamaSearch,
  isOllamaSearchConfigured
} from '../ollama-search-client'

describe('ollama-search-client', () => {
  beforeEach(() => {
    delete process.env.OLLAMA_SEARCH_API_KEY
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.OLLAMA_SEARCH_API_KEY
  })

  it('isOllamaSearchConfigured reflects the key', () => {
    expect(isOllamaSearchConfigured()).toBe(false)
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    expect(isOllamaSearchConfigured()).toBe(true)
  })

  it('returns null when the key is unset (feature inert)', async () => {
    const res = await fetchOllamaSearch('rust', 3)
    expect(res).toBeNull()
  })

  it('parses {results:[{title,url,content}]} on success', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { title: 'A', url: 'https://a.com', content: 'aaa' },
          { title: 'B', url: 'https://b.com', content: 'bbb' }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchOllamaSearch('rust', 2)
    expect(res).toEqual([
      { title: 'A', url: 'https://a.com', content: 'aaa' },
      { title: 'B', url: 'https://b.com', content: 'bbb' }
    ])
    // sends POST with bearer auth + max_results
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer k')
    expect(JSON.parse(init.body)).toEqual({ query: 'rust', max_results: 2 })
  })

  it('throws on a non-OK response', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    )
    await expect(fetchOllamaSearch('rust', 3)).rejects.toThrow(/429/)
  })

  it('drops results with no url', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ title: 'x', content: 'c' }, { url: 'https://y.com' }] })
      })
    )
    const res = await fetchOllamaSearch('rust', 3)
    expect(res).toEqual([{ title: '', url: 'https://y.com', content: '' }])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test lib/utils/__tests__/ollama-search-client.test.ts`
Expected: FAIL — cannot find module `../ollama-search-client`.

- [ ] **Step 3: Create the client**

Create `lib/utils/ollama-search-client.ts`:

```typescript
// Client for Ollama's hosted web search (a complement to SearXNG/degoog, not a
// replacement). Runs on Ollama's servers, so it egresses from Ollama's IPs, not
// our residential IP — immune to the DDG/Startpage-style IP blocking that hits
// self-hosted engines. Returns full page content per result. Inert unless
// OLLAMA_SEARCH_API_KEY (the Ollama CLOUD key, distinct from OLLAMA_BASE_URL) is
// set. Mirrors degoog-client's null-when-unconfigured / throw-on-failure /
// circuit-breaker contract.

const OLLAMA_SEARCH_ENDPOINT = 'https://ollama.com/api/web_search'
const DEFAULT_TIMEOUT_MS = 10_000
const BREAKER_COOLDOWN_MS = 30_000

let downUntil = 0

export interface OllamaSearchResult {
  title: string
  url: string
  content: string
}

export function isOllamaSearchConfigured(): boolean {
  return Boolean(process.env.OLLAMA_SEARCH_API_KEY)
}

/**
 * Query Ollama web search. Returns `null` when unconfigured (callers treat
 * Ollama as optional). Throws on timeout/non-OK/network so callers can degrade
 * to searxng+degoog. A short circuit-breaker cooldown suppresses repeated
 * attempts during an outage.
 */
export async function fetchOllamaSearch(
  query: string,
  maxResults: number,
  options: { timeoutMs?: number } = {}
): Promise<OllamaSearchResult[] | null> {
  const apiKey = process.env.OLLAMA_SEARCH_API_KEY
  if (!apiKey) return null

  if (Date.now() < downUntil) {
    throw new Error('ollama web search is in circuit-breaker cooldown')
  }

  const envTimeout = Number(process.env.OLLAMA_SEARCH_TIMEOUT_MS)
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(OLLAMA_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`ollama web search responded with ${response.status}`)
    }
    const json = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>
    }
    const results = (json.results ?? [])
      .filter(
        (r): r is { url: string; title?: string; content?: string } =>
          Boolean(r) && typeof r.url === 'string' && r.url.length > 0
      )
      .map(r => ({
        title: r.title ?? '',
        url: r.url,
        content: r.content ?? ''
      }))
    downUntil = 0
    return results
  } catch (error) {
    downUntil = Date.now() + BREAKER_COOLDOWN_MS
    throw error
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `bun run test lib/utils/__tests__/ollama-search-client.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, format, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && bun format lib/utils/ollama-search-client.ts lib/utils/__tests__/ollama-search-client.test.ts
git add lib/utils/ollama-search-client.ts lib/utils/__tests__/ollama-search-client.test.ts
git commit -m "feat(search): ollama web search client (hosted, degoog-style graceful complement)"
```

---

## Task 2: Ollama merge helpers

**Files:**
- Modify: `lib/tools/search/providers/merge-degoog.ts` (export `normalizeUrl`)
- Create: `lib/tools/search/providers/merge-ollama.ts`
- Create: `lib/tools/search/providers/__tests__/merge-ollama.test.ts`

**Interfaces:**
- Consumes: `OllamaSearchResult` (Task 1); `normalizeUrl` from `merge-degoog`.
- Produces: `mergeOllamaIntoSearxngResults(searxngResults: SearXNGResult[], ollamaResults: OllamaSearchResult[], maxResults: number): SearXNGResult[]` (full content); `mergeOllamaIntoResults(items: SearchResultItem[], ollamaResults: OllamaSearchResult[], maxResults: number, maxContentChars: number): SearchResultItem[]` (truncated).

- [ ] **Step 1: Export `normalizeUrl` from merge-degoog**

In `lib/tools/search/providers/merge-degoog.ts`, change `function normalizeUrl(` to `export function normalizeUrl(`. (No other change.)

- [ ] **Step 2: Write the failing test**

Create `lib/tools/search/providers/__tests__/merge-ollama.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import {
  mergeOllamaIntoResults,
  mergeOllamaIntoSearxngResults
} from '../merge-ollama'

const oll = (url: string, content = 'x') => ({ title: 't', url, content })

describe('mergeOllamaIntoSearxngResults', () => {
  it('appends unique ollama results with FULL content', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://b.com', 'long full content')],
      10
    )
    expect(merged.map(r => r.url).sort()).toEqual(['https://a.com', 'https://b.com'])
    expect(merged.find(r => r.url === 'https://b.com')!.content).toBe('long full content')
  })

  it('dedupes an ollama result that duplicates an existing URL', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com/', content: 'snip' }],
      [oll('https://a.com')],
      10
    )
    expect(merged).toHaveLength(1)
  })

  it('caps at maxResults', () => {
    const merged = mergeOllamaIntoSearxngResults(
      [{ title: 's', url: 'https://a.com', content: 'c' }],
      [oll('https://b.com'), oll('https://c.com')],
      2
    )
    expect(merged).toHaveLength(2)
  })
})

describe('mergeOllamaIntoResults', () => {
  it('truncates ollama content to maxContentChars', () => {
    const merged = mergeOllamaIntoResults(
      [],
      [oll('https://b.com', 'abcdefghij')],
      10,
      4
    )
    expect(merged[0].content).toBe('abcd…')
  })

  it('keeps short content untouched and dedupes by URL', () => {
    const merged = mergeOllamaIntoResults(
      [{ title: 's', url: 'https://a.com', content: 'snip' }],
      [oll('https://a.com', 'dup'), oll('https://b.com', 'ok')],
      10,
      100
    )
    expect(merged.map(r => r.url)).toEqual(['https://a.com', 'https://b.com'])
    expect(merged[1].content).toBe('ok')
  })
})
```

- [ ] **Step 3: Run to confirm it fails**

Run: `bun run test lib/tools/search/providers/__tests__/merge-ollama.test.ts`
Expected: FAIL — cannot find module `../merge-ollama`.

- [ ] **Step 4: Create the merge helper**

Create `lib/tools/search/providers/merge-ollama.ts`:

```typescript
import type { SearchResultItem, SearXNGResult } from '@/lib/types'
import type { OllamaSearchResult } from '@/lib/utils/ollama-search-client'

import { normalizeUrl } from './merge-degoog'

/**
 * Merge Ollama results into a SearXNG result list as additional crawl+rerank
 * candidates for the ADVANCED path — carrying their FULL content (the advanced
 * route skips Crawl4AI for these URLs, so this content is what the reranker and
 * model see). Deduped by normalized URL against the existing list, capped.
 */
export function mergeOllamaIntoSearxngResults(
  searxngResults: SearXNGResult[],
  ollamaResults: OllamaSearchResult[],
  maxResults: number
): SearXNGResult[] {
  const seen = new Set(searxngResults.map(r => normalizeUrl(r.url)))
  const merged: SearXNGResult[] = [...searxngResults]
  for (const r of ollamaResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push({ title: r.title, url: r.url, content: r.content })
  }
  return merged.slice(0, maxResults)
}

/**
 * Merge Ollama results into a plain results list for the BASIC path, with
 * content TRUNCATED to maxContentChars so results stay snippet-uniform (the
 * basic path returns snippets, not full crawled content). Deduped by URL.
 */
export function mergeOllamaIntoResults(
  items: SearchResultItem[],
  ollamaResults: OllamaSearchResult[],
  maxResults: number,
  maxContentChars: number
): SearchResultItem[] {
  const seen = new Set(items.map(i => normalizeUrl(i.url)))
  const merged: SearchResultItem[] = [...items]
  for (const r of ollamaResults) {
    const key = normalizeUrl(r.url)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const content =
      r.content.length > maxContentChars
        ? r.content.slice(0, maxContentChars) + '…'
        : r.content
    merged.push({ title: r.title, url: r.url, content })
  }
  return merged.slice(0, maxResults)
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `bun run test lib/tools/search/providers/__tests__/merge-ollama.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Lint, typecheck, format, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && bun format lib/tools/search/providers/merge-ollama.ts lib/tools/search/providers/merge-degoog.ts lib/tools/search/providers/__tests__/merge-ollama.test.ts
git add lib/tools/search/providers/merge-ollama.ts lib/tools/search/providers/merge-degoog.ts lib/tools/search/providers/__tests__/merge-ollama.test.ts
git commit -m "feat(search): ollama merge helpers (full content for advanced, truncated for basic)"
```

---

## Task 3: Plumb `useOllama` + basic-path integration

**Files:**
- Modify: `lib/tools/search.ts` (compute `useOllama`/`ollamaMaxResults`, pass to both paths)
- Modify: `lib/tools/search/providers/base.ts` (`SearchProviderOptions` + `useOllama`/`ollamaMaxResults`)
- Modify: `lib/tools/search/providers/searxng.ts` (basic path: fetch + merge Ollama)
- Test: `lib/tools/search/providers/__tests__/searxng.test.ts`

**Interfaces:**
- Consumes: `isOllamaSearchConfigured`, `fetchOllamaSearch` (Task 1); `mergeOllamaIntoResults` (Task 2).
- Produces: `SearchProviderOptions.useOllama?: boolean`, `ollamaMaxResults?: number`; the searxng provider merges Ollama into `results` when `options.useOllama`.

- [ ] **Step 1: Write the failing basic-path test**

Add to `lib/tools/search/providers/__tests__/searxng.test.ts` (inside the `describe('SearXNGSearchProvider', …)` block). Note: this file mocks `fetch` globally; the Ollama client also uses `fetch`, so branch the mock on URL:

```typescript
  it('merges ollama results (truncated) into results when useOllama is set', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('ollama.com/api/web_search')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            results: [
              { title: 'Ollama Src', url: 'https://ollama-src.com', content: 'x'.repeat(1000) }
            ]
          })
        })
      }
      return Promise.resolve(mockSearxngResponse([
        { title: 'SX', url: 'https://sx.com', content: 'sx snippet' }
      ]))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.search('rust', 10, 'basic', [], [], {
      useOllama: true,
      ollamaMaxResults: 3
    })

    const urls = result.results.map(r => r.url)
    expect(urls).toContain('https://ollama-src.com')
    expect(urls).toContain('https://sx.com')
    // truncated on the basic path
    const oll = result.results.find(r => r.url === 'https://ollama-src.com')!
    expect(oll.content.length).toBeLessThan(1000)

    delete process.env.OLLAMA_SEARCH_API_KEY
  })

  it('does not call ollama when useOllama is unset', async () => {
    process.env.OLLAMA_SEARCH_API_KEY = 'k'
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('rust', 10, 'basic', [], [], {})

    const calledOllama = fetchMock.mock.calls.some(c =>
      String(c[0]).includes('ollama.com/api/web_search')
    )
    expect(calledOllama).toBe(false)
    delete process.env.OLLAMA_SEARCH_API_KEY
  })
```

- [ ] **Step 2: Run to confirm they fail**

Run: `bun run test lib/tools/search/providers/__tests__/searxng.test.ts`
Expected: the two new tests FAIL (ollama never called / not merged).

- [ ] **Step 3: Add options to `base.ts`**

In `lib/tools/search/providers/base.ts`, add to `SearchProviderOptions` (alongside `intent`/`time_range`):

```typescript
  // Per-search Ollama web-search inclusion (set by the search tool). When true,
  // the provider also queries Ollama's hosted web search and merges its results
  // (snippet-truncated on the basic path). Additive complement — failure is
  // swallowed, never fails the search.
  useOllama?: boolean
  ollamaMaxResults?: number
```

- [ ] **Step 4: Wire the basic path in `searxng.ts`**

In `lib/tools/search/providers/searxng.ts`:

Add imports:

```typescript
import {
  fetchOllamaSearch,
  type OllamaSearchResult
} from '@/lib/utils/ollama-search-client'

import { mergeOllamaIntoResults } from './merge-ollama'
```

Add the constant near the top of the file (after imports):

```typescript
// Truncate Ollama's full page content to snippet size on the basic path so
// results stay uniform with searxng/degoog snippets.
const OLLAMA_BASIC_SNIPPET_CHARS = 400
```

Add the Ollama fetch to the existing `Promise.allSettled([...])` array (the one with `fetchSearxngJson` + degoog fetches). Append one more entry at the END of that array:

```typescript
        options?.useOllama
          ? fetchOllamaSearch(query, options.ollamaMaxResults ?? 5)
          : Promise.resolve(null)
```

and capture it by adding `ollamaSettled` to the destructured results array (append at the end, matching the appended promise).

After the degoog results are extracted, extract Ollama results (never throws):

```typescript
      const ollamaResults: OllamaSearchResult[] =
        ollamaSettled.status === 'fulfilled' && ollamaSettled.value
          ? ollamaSettled.value
          : []
      if (ollamaSettled.status === 'rejected') {
        console.warn(
          '[ollama] basic web search failed, continuing without it:',
          ollamaSettled.reason
        )
      }
```

Finally, apply the Ollama merge to the returned `results` field. Replace the `results:` value in the `return { … }` at the end of the try block:

```typescript
        results: (() => {
          const base =
            degoogTextResults.length > 0
              ? mergeWithDegoogResults(baseResults, degoogTextResults, maxResults)
              : baseResults
          return ollamaResults.length > 0
            ? mergeOllamaIntoResults(
                base,
                ollamaResults,
                maxResults,
                OLLAMA_BASIC_SNIPPET_CHARS
              )
            : base
        })(),
```

(Also apply the same Ollama merge in the degoog-only fallback return path if present — the SearXNG-rejected/degoog-only branch. If that branch exists, merge `ollamaResults` into its `results` the same way so Ollama still contributes when SearXNG is down.)

- [ ] **Step 5: Compute + pass `useOllama` in `search.ts`**

In `lib/tools/search.ts`:

Add the import:

```typescript
import { isOllamaSearchConfigured } from '@/lib/utils/ollama-search-client'
```

Immediately AFTER the line `firstSearchDone = true` (right after the depth-resolution block), add:

```typescript
      // Ollama web search runs on EVERY executing search of the turn when
      // enabled (no per-turn cap). A dedup-skipped search returns earlier and
      // never reaches here, so Ollama is only called for real searches.
      const useOllama =
        isOllamaSearchConfigured() && process.env.OLLAMA_SEARCH_ENABLED !== 'off'
      const ollamaMaxEnv = Number(process.env.OLLAMA_SEARCH_MAX_RESULTS)
      const ollamaMaxResults =
        Number.isFinite(ollamaMaxEnv) && ollamaMaxEnv > 0 ? ollamaMaxEnv : 5
```

In the **advanced** POST body (the `fetch(\`${baseUrl}/api/advanced-search\`)` call), add to the JSON body:

```typescript
              useOllama,
              ollamaMaxResults
```

In the **basic** `searchAPI === 'searxng'` provider `.search(...)` options object, add:

```typescript
                useOllama,
                ollamaMaxResults
```

- [ ] **Step 6: Run tests**

Run: `bun run test lib/tools/search/providers/__tests__/searxng.test.ts lib/tools/__tests__/search-to-model-output.test.ts lib/agents/__tests__/researcher.test.ts`
Expected: PASS (all, including the two new basic-path tests).

- [ ] **Step 7: Lint, typecheck, format, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && bun format lib/tools/search.ts lib/tools/search/providers/base.ts lib/tools/search/providers/searxng.ts lib/tools/search/providers/__tests__/searxng.test.ts
git add lib/tools/search.ts lib/tools/search/providers/base.ts lib/tools/search/providers/searxng.ts lib/tools/search/providers/__tests__/searxng.test.ts
git commit -m "feat(search): plumb useOllama flag + merge ollama on the basic search path"
```

---

## Task 4: Advanced-path integration (merge + skip-Crawl4AI)

**Files:**
- Modify: `app/api/advanced-search/route.ts`

**Interfaces:**
- Consumes: `fetchOllamaSearch`, `OllamaSearchResult` (Task 1); `mergeOllamaIntoSearxngResults` (Task 2).

- [ ] **Step 1: Read `useOllama`/`ollamaMaxResults` from the POST body**

In `app/api/advanced-search/route.ts` `POST`, destructure them from the body:

```typescript
  const {
    query,
    maxResults,
    searchDepth,
    includeDomains,
    excludeDomains,
    timeRange,
    intent,
    useOllama,
    ollamaMaxResults
  } = await request.json()
```

Add to the Redis `cacheKey` (append so Ollama vs non-Ollama results don't collide):

```typescript
    }:${typeof intent === 'string' ? intent : ''}:${useOllama ? `oll${ollamaMaxResults ?? 5}` : ''}`
```

Pass into `advancedSearchXNGSearch`:

```typescript
      typeof intent === 'string' ? (intent as SearchIntent) : 'general',
      Boolean(useOllama),
      typeof ollamaMaxResults === 'number' ? ollamaMaxResults : 5
```

- [ ] **Step 2: Extend `advancedSearchXNGSearch` signature + imports**

Add imports (with the existing ones):

```typescript
import {
  fetchOllamaSearch,
  type OllamaSearchResult
} from '@/lib/utils/ollama-search-client'
import { mergeOllamaIntoSearxngResults } from '@/lib/tools/search/providers/merge-ollama'
```

Extend the signature (after the `intent` param):

```typescript
async function advancedSearchXNGSearch(
  query: string,
  maxResults: number = 10,
  searchDepth: 'basic' | 'advanced' = 'advanced',
  includeDomains: string[] = [],
  excludeDomains: string[] = [],
  timeRange?: string,
  intent: SearchIntent = 'general',
  useOllama = false,
  ollamaMaxResults = 5
): Promise<SearXNGSearchResults> {
```

- [ ] **Step 3: Fetch Ollama concurrently**

In the `Promise.allSettled([...])` that runs SearXNG + degoog, append an Ollama entry, and capture it:

```typescript
    const [searxngSettled, degoogWebSettled, degoogNewsSettled, degoogImgSettled, ollamaSettled] =
      await Promise.allSettled([
        fetchSearxngJson(buildUrl),
        fetchDegoogJson(degoogUrl('web')),
        intent === 'news' ? fetchDegoogJson(degoogUrl('news')) : Promise.resolve(null),
        fetchDegoogJson(degoogUrl('images')),
        useOllama ? fetchOllamaSearch(query, ollamaMaxResults) : Promise.resolve(null)
      ])
```

(Match the existing destructuring order for the first four; only append `ollamaSettled`.)

After the degoog extraction, extract Ollama results:

```typescript
    const ollamaResults: OllamaSearchResult[] =
      ollamaSettled.status === 'fulfilled' && ollamaSettled.value
        ? (ollamaSettled.value as OllamaSearchResult[])
        : []
    if (ollamaSettled.status === 'rejected') {
      console.warn(
        '[ollama] advanced web search failed, continuing without it:',
        ollamaSettled.reason
      )
    }
    const prefetchedUrls = new Set(ollamaResults.map(r => r.url))
```

- [ ] **Step 4: Merge Ollama into candidates (before crawl)**

Immediately AFTER the existing degoog merge block (`if (degoogWeb.length > 0) { generalResults = mergeDegoogIntoSearxngResults(...) }`) and BEFORE the `if (searchDepth === 'advanced')` crawl block, add:

```typescript
    // Ollama results carry full content already — merge them into the candidate
    // pool so they're reranked alongside crawled searxng/degoog results. They
    // are tagged (prefetchedUrls) so the crawl step below skips them.
    if (ollamaResults.length > 0) {
      generalResults = mergeOllamaIntoSearxngResults(
        generalResults,
        ollamaResults,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }
```

- [ ] **Step 5: Skip Crawl4AI for prefetched (Ollama) URLs**

Inside the `if (searchDepth === 'advanced')` block:

Exclude prefetched URLs from the Crawl4AI batch — change `toEnrich`:

```typescript
      const toEnrich = candidates
        .filter(r => !prefetchedUrls.has(r.url))
        .slice(0, MAX_ENRICH_URLS)
```

In the per-candidate crawl map, keep a prefetched candidate's own content (apply the same highlight/substring treatment as a crawled result, so it's consistent) instead of calling `crawlPage`:

```typescript
      const crawledResults = await Promise.all(
        candidates.map(async result => {
          if (prefetchedUrls.has(result.url)) {
            // Ollama already fetched this — keep its content, don't crawl.
            return {
              ...result,
              content: highlightQueryTerms(
                `${result.title}\n\n${result.content}`.substring(0, 10000),
                query
              )
            }
          }
          const hit = byUrl.get(result.url)
          if (!hit) return crawlPage(result, query)
          return {
            ...result,
            content: highlightQueryTerms(
              `${result.title}\n\n${hit.markdown}`.substring(0, 10000),
              query
            )
          }
        })
      )
```

- [ ] **Step 6: Typecheck + adjacent unit suites**

Run: `cd /home/nightfury/selfhosted/ask && bun typecheck && bun run test lib/tools/search/providers/__tests__/merge-ollama.test.ts lib/utils/__tests__/ollama-search-client.test.ts`
Expected: typecheck clean; unit tests PASS. (The route itself is verified in live E2E — it has no unit harness in this repo; mocking Redis + Crawl4AI + three backends would test mocks, not behavior. The Ollama client, merge helper, and flag plumbing are all unit-tested.)

- [ ] **Step 7: Lint, format, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck && bun format app/api/advanced-search/route.ts
git add app/api/advanced-search/route.ts
git commit -m "feat(search): merge ollama into the advanced path, skip Crawl4AI for its prefetched content"
```

---

## Task 5: Env docs + enablement

**Files:**
- Modify: `.env.local.example`

**Interfaces:** none (config/docs only).

- [ ] **Step 1: Document the env vars**

In `.env.local.example`, add a section (near the SearXNG/degoog config):

```bash
# Ollama hosted web search (a complement to SearXNG/degoog — runs on Ollama's
# servers, so it's immune to the IP-blocking that hits self-hosted engines, and
# returns full page content). CLOUD key (distinct from OLLAMA_BASE_URL). The
# feature is inert unless OLLAMA_SEARCH_API_KEY is set.
# OLLAMA_SEARCH_API_KEY=
# OLLAMA_SEARCH_ENABLED=on          # only "off" disables
# OLLAMA_SEARCH_MAX_RESULTS=5       # results per Ollama call
# OLLAMA_SEARCH_TIMEOUT_MS=10000
```

- [ ] **Step 2: Commit**

```bash
cd /home/nightfury/selfhosted/ask
git add .env.local.example
git commit -m "docs(search): document Ollama web search env vars"
```

- [ ] **Step 3: Note for deployment (not a code step)**

The feature stays inert until `OLLAMA_SEARCH_API_KEY` is added to the real `.env` (reuse the existing Ollama cloud key). Add it at deploy time; do not commit the key.

---

## Final verification (whole branch)

- [ ] **Full suite:** `cd /home/nightfury/selfhosted/ask && bun run test` — all pass.
- [ ] **Lint + types + build:** `bun lint && bun typecheck && bun run build` — clean (build gets `DATABASE_URL` only inside Docker; if building on the host fails solely on that env at page-data collection, the TypeScript compile still validates — the real build runs in the container).
- [ ] **Staging E2E** (add `OLLAMA_SEARCH_API_KEY` to the staging env, rebuild `admin-feature`, browser-test on `localhost:3739` per the standard staging flow; do NOT push to dev/origin or redeploy production until reviewed):
  1. A balanced turn's results include Ollama-sourced URLs (check the results/logs).
  2. Advanced-search logs show `crawl4ai enriched X/Y` where Ollama URLs are NOT among the crawled set, yet Ollama content still appears in the reranked output (skip-crawl works).
  3. Unset `OLLAMA_SEARCH_API_KEY` (or `OLLAMA_SEARCH_ENABLED=off`) → search still works on searxng+degoog, no errors (graceful degradation).
- [ ] **Summarize** all changes for review. Do not push/redeploy until the user approves.

---

## Self-Review (completed)

- **Spec coverage:** client → Task 1; merge helpers → Task 2; per-search inclusion (no cap) + basic path → Task 3; advanced path + skip-Crawl4AI + cache key → Task 4; env → Task 5. All spec sections covered.
- **Type consistency:** `OllamaSearchResult` defined in Task 1, consumed in Tasks 2–4; `SearchProviderOptions.useOllama`/`ollamaMaxResults` added in Task 3 and consumed by the provider + set in `search.ts`; `normalizeUrl` exported in Task 2 and used by `merge-ollama`.
- **No placeholders:** every code step carries complete code.
- **Known deviation from strict TDD:** the advanced-search route wiring (Task 4) has no unit test (Redis + Crawl4AI + three backends would test mocks); its pure helper + client are unit-tested and it's covered by staging E2E. Called out so the reviewer doesn't flag it as a gap.
