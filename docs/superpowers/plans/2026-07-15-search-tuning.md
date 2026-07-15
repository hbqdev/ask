# Search Fine-Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three composable levers to Ask's web search — additive query-intent engine routing, per-turn depth tiering, and search-intent dedup — plus degoog parity on the advanced search path.

**Architecture:** The per-turn query classifier gains an `intent` field that maps to one additive SearXNG category (general baseline always fires). The search tool's per-turn closure (`createSearchTool`) forces only the first search to run advanced (crawl+rerank) and skips near-duplicate reformulations via local embeddings. The advanced-search route gains degoog querying so both search paths share the same SearXNG+degoog source union.

**Tech Stack:** Next.js 16 / React 19, Vercel AI SDK, TypeScript, Vitest, SearXNG + degoog metasearch, granite4.1:8b classifier (Ollama on serenity), local MiniLM embeddings (@huggingface/transformers).

## Global Constraints

- **Additive intent, never replacing:** intent adds one category on top of the always-on general baseline. `intent='general'` adds nothing. The user-selected Academic/Social branches (`isAcademic`/`isSocial` in `searxng.ts`, `wrapSearchToolForSources` in `researcher.ts`) stay EXCLUSIVE and MUST NOT be touched.
- **Fail-safe:** every lever degrades to today's behavior on failure. Classifier failure ⇒ `intent='general'`. Embedding failure in dedup ⇒ treat as not-duplicate (search runs). Any lever toggled off via env ⇒ that lever is a no-op.
- **Env toggles & defaults (exact):** `SEARCH_DEPTH_TIERING` default ON (only `'off'` disables). `SEARCH_DEDUP_ENABLED` default ON (only `'off'` disables). `SEARCH_DEDUP_THRESHOLD` default `0.92`.
- **Intent taxonomy (exact 5 values):** `general | code | discussion | news | academic`. Category map: `code→it`, `discussion→social media`, `news→news`, `academic→science`, `general→(none)`.
- **Both search paths get intent + degoog:** basic path (`lib/tools/search/providers/searxng.ts` `else` branch) and advanced path (`app/api/advanced-search/route.ts`). Depth tiering routes the first (deepest) search to the advanced path, so degoog parity there is required, not optional.
- **Testing:** `bun run test` (NOT `bun test`). Pre-commit: `bun lint --fix` (import sorting is enforced by ESLint), `bun typecheck`. Do NOT push to dev/origin or redeploy — staging build/test only, then summarize.

---

## File Structure

- **Create** `lib/tools/search/intent.ts` — single source of truth for `SEARCH_INTENTS`, `SearchIntent` type, and `intentToCategory()`. Imported by the classifier, the basic provider, and the advanced route (no drift).
- **Modify** `lib/agents/query-classifier.ts` — add `intent` to schema/interface/prompt/fallback.
- **Modify** `lib/tools/search/providers/searxng.ts` — append intent category in the general `else` branch (basic path).
- **Modify** `app/api/advanced-search/route.ts` — read `intent`, append category, query+merge degoog (advanced path).
- **Modify** `lib/tools/search/providers/merge-degoog.ts` — add `mergeDegoogIntoSearxngResults` helper (degoog web → SearXNGResult candidates for crawl+rerank).
- **Modify** `lib/tools/search.ts` — `SearchToolOptions` gains `intent` + `firstSearchDepth`; closure gains depth-tiering + dedup state; add `resolveEffectiveDepth` + dedup helpers.
- **Modify** `lib/agents/researcher.ts` — plumb `intent` and set `firstSearchDepth` per mode.
- **Modify** `lib/streaming/create-chat-stream-response.ts` and `lib/streaming/create-ephemeral-chat-stream-response.ts` — pass `classification.intent` to `researcher()`.
- **Modify** `lib/agents/prompts/search-mode-prompts.ts` — depth-tiering guidance for balanced+quality.

---

## Task 1: Shared intent module + classifier `intent` field

**Files:**
- Create: `lib/tools/search/intent.ts`
- Create: `lib/tools/search/__tests__/intent.test.ts`
- Modify: `lib/agents/query-classifier.ts`
- Test: `lib/agents/__tests__/query-classifier.test.ts`

**Interfaces:**
- Produces: `SEARCH_INTENTS: readonly ['general','code','discussion','news','academic']`; `type SearchIntent = (typeof SEARCH_INTENTS)[number]`; `intentToCategory(intent: SearchIntent): string | null` (null for `general`). `QueryClassification` gains `intent: SearchIntent`.

- [ ] **Step 1: Write the failing test for the intent module**

Create `lib/tools/search/__tests__/intent.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { intentToCategory, SEARCH_INTENTS } from '../intent'

describe('intentToCategory', () => {
  it('maps each non-general intent to its additive SearXNG category', () => {
    expect(intentToCategory('code')).toBe('it')
    expect(intentToCategory('discussion')).toBe('social media')
    expect(intentToCategory('news')).toBe('news')
    expect(intentToCategory('academic')).toBe('science')
  })

  it('returns null for general (adds nothing to the baseline)', () => {
    expect(intentToCategory('general')).toBeNull()
  })

  it('exposes exactly the five supported intents', () => {
    expect([...SEARCH_INTENTS]).toEqual([
      'general',
      'code',
      'discussion',
      'news',
      'academic'
    ])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun run test lib/tools/search/__tests__/intent.test.ts`
Expected: FAIL — cannot find module `../intent`.

- [ ] **Step 3: Create the intent module**

Create `lib/tools/search/intent.ts`:

```typescript
// Single source of truth for auto-detected search intent (set by the query
// classifier) and its ADDITIVE SearXNG category. Imported by the classifier,
// the basic SearXNG provider, and the advanced-search route so the mapping
// never drifts across the two search paths.
//
// Additive contract: intent adds AT MOST one category on top of the always-on
// general baseline. 'general' adds nothing. Verified live that SearXNG unions
// `categories` with any pinned `engines`, so appending a category cannot
// starve the baseline — it only adds specialized engines.

export const SEARCH_INTENTS = [
  'general',
  'code',
  'discussion',
  'news',
  'academic'
] as const

export type SearchIntent = (typeof SEARCH_INTENTS)[number]

const INTENT_TO_CATEGORY: Record<SearchIntent, string | null> = {
  general: null, // baseline only — adds nothing
  code: 'it', // github, stackoverflow, mdn, pypi, npm, docker hub…
  discussion: 'social media', // hackernews, lobste.rs, lemmy, mastodon
  news: 'news', // google news, bing news… (pairs with needsRecent)
  academic: 'science' // arxiv, pubmed, scholar, semantic scholar, crossref…
}

// The additive category for an intent, or null when nothing should be added
// (general). Callers append the returned category to their existing
// `general,images` category list; null means leave the list unchanged.
export function intentToCategory(intent: SearchIntent): string | null {
  return INTENT_TO_CATEGORY[intent] ?? null
}
```

- [ ] **Step 4: Run the intent-module test to confirm it passes**

Run: `bun run test lib/tools/search/__tests__/intent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing classifier tests**

Add to `lib/agents/__tests__/query-classifier.test.ts` (inside the existing `describe('classifyQuery', …)` block):

```typescript
  it('returns the model-provided intent on success', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        skipSearch: false,
        standaloneQuery: 'latest node.js LTS version',
        needsRecent: true,
        intent: 'code'
      }
    } as any)

    const result = await classifyQuery({
      messages: [userMsg('whats the newest node lts')]
    })

    expect(result.intent).toBe('code')
  })

  it('falls back to intent="general" when the classifier errors', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'))

    const result = await classifyQuery({
      messages: [userMsg('anything')]
    })

    expect(result.intent).toBe('general')
    expect(result.skipSearch).toBe(false)
  })
```

- [ ] **Step 6: Run the classifier tests to confirm the new ones fail**

Run: `bun run test lib/agents/__tests__/query-classifier.test.ts`
Expected: the two new tests FAIL (`result.intent` is `undefined`); existing tests still pass.

- [ ] **Step 7: Add `intent` to the classifier schema, interface, prompt, and fallback**

In `lib/agents/query-classifier.ts`:

Add the import near the top (with the other imports):

```typescript
import { SEARCH_INTENTS } from '../tools/search/intent'
```

Replace `classifierSchema`:

```typescript
const classifierSchema = z.object({
  skipSearch: z.boolean(),
  standaloneQuery: z.string(),
  needsRecent: z.boolean(),
  intent: z.enum(SEARCH_INTENTS)
})
```

Extend the `QueryClassification` interface — add after `needsRecent`:

```typescript
  // The kind of sources most useful for this turn. Maps to ONE additive
  // SearXNG category (intentToCategory) on top of the always-on general
  // baseline — never replaces it. 'general' adds nothing. A wrong guess is
  // harmless because the baseline always fires.
  intent: import('../tools/search/intent').SearchIntent
```

In `CLASSIFIER_SYSTEM_PROMPT`, insert this block immediately BEFORE the line `If uncertain about needsRecent, default to needsRecent=false.`:

```
You also set intent — the kind of sources most useful for answering:
- "code": programming, libraries, APIs, error messages, package/tooling questions, software how-to, technical documentation.
- "discussion": opinions, recommendations, personal experiences, "what do people think about X", community consensus.
- "news": current events, breaking news, recent happenings, "what happened with X".
- "academic": research papers, scientific or medical evidence, scholarly citations, studies.
- "general": everything else, or whenever you are not clearly in one of the above.

Only leave "general" when the intent is clearly one of the others. If uncertain, use "general".
```

Update the six existing examples to include `intent`, and add two more. Replace the entire `Examples:` block (through the final `standaloneQuery is always…` line) with:

```
Examples:
1) Assistant said "Mount Fuji is the tallest mountain in Japan." User: "what about South Korea" -> South Korea is a NEW entity never mentioned -> skipSearch=false, needsRecent=false (geography is stable), intent="general", standaloneQuery="What is the tallest mountain in South Korea?"
2) Assistant said "Option 1: X. Option 2: Y. Best practice: do both." User: "so you are saying to do both, right?" -> no new entity, already answered -> skipSearch=true, needsRecent=false, intent="general", standaloneQuery="Confirm: should I do both X and Y?"
3) User: "hey how is it going" -> casual -> skipSearch=true, needsRecent=false, intent="general", standaloneQuery="greeting, no search needed"
4) Assistant said "The capital of France is Paris." User: "and Germany?" -> Germany is a NEW entity -> skipSearch=false, needsRecent=false, intent="general", standaloneQuery="What is the capital of Germany?"
5) User: "what's the latest stable version of Node.js" -> version info changes constantly and this is a software question -> skipSearch=false, needsRecent=true, intent="code", standaloneQuery="What is the latest stable version of Node.js?"
6) User: "did anything major happen in AI this week" -> current events -> skipSearch=false, needsRecent=true, intent="news", standaloneQuery="Major AI news this week"
7) User: "what mechanical keyboard do people actually recommend" -> opinions/community consensus -> skipSearch=false, needsRecent=false, intent="discussion", standaloneQuery="Recommended mechanical keyboards according to users"
8) User: "does creatine actually improve muscle recovery, any studies" -> scientific evidence -> skipSearch=false, needsRecent=false, intent="academic", standaloneQuery="Does creatine improve muscle recovery (research evidence)?"

standaloneQuery is always a short plain string, never empty, never a meta-question back to the user.
```

Update the `fallback` object (in `classifyQuery`) to include intent:

```typescript
  const fallback: QueryClassification = {
    skipSearch: false,
    standaloneQuery: latestMessage,
    needsRecent: false,
    intent: 'general'
  }
```

- [ ] **Step 8: Run the classifier tests to confirm they pass**

Run: `bun run test lib/agents/__tests__/query-classifier.test.ts`
Expected: PASS (all, including the two new ones).

- [ ] **Step 9: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/tools/search/intent.ts lib/tools/search/__tests__/intent.test.ts lib/agents/query-classifier.ts lib/agents/__tests__/query-classifier.test.ts
git commit -m "feat(search): add intent to query classifier + shared intent→category map"
```

---

## Task 2: Plumb intent end-to-end + basic-path routing

**Files:**
- Modify: `lib/tools/search.ts` (add `intent` to `SearchToolOptions`, forward to provider + advanced body)
- Modify: `lib/agents/researcher.ts` (accept `intent`, forward to `createSearchTool`)
- Modify: `lib/streaming/create-chat-stream-response.ts` and `lib/streaming/create-ephemeral-chat-stream-response.ts` (pass `classification.intent`)
- Modify: `lib/tools/search/providers/searxng.ts` (append intent category in `else` branch)
- Test: `lib/tools/search/providers/__tests__/searxng.test.ts`

**Interfaces:**
- Consumes: `SearchIntent`, `intentToCategory` (Task 1).
- Produces: `SearchToolOptions.intent?: SearchIntent`; `createResearcher({ …, intent?: SearchIntent })`; `SearXNGSearchProvider.search` accepts `options.intent?: SearchIntent`.

- [ ] **Step 1: Write the failing basic-path tests**

Add to `lib/tools/search/providers/__tests__/searxng.test.ts` (inside the `describe('SearXNGSearchProvider', …)` block):

```typescript
  it('appends the intent category (code -> it) on top of general,images', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('python asyncio gather', 10, 'basic', [], [], {
      intent: 'code'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images,it')
  })

  it('adds nothing for intent=general', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('hello world', 10, 'basic', [], [], {
      intent: 'general'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images')
  })

  it('does not apply intent routing in the exclusive academic branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('quantum error correction', 10, 'basic', [], [], {
      searchMode: 'academic',
      intent: 'code'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('science')
  })
```

- [ ] **Step 2: Run to confirm they fail**

Run: `bun run test lib/tools/search/providers/__tests__/searxng.test.ts`
Expected: the three new tests FAIL (intent ignored — categories stays `general,images`).

- [ ] **Step 3: Add intent to the SearXNG provider (basic path only)**

In `lib/tools/search/providers/searxng.ts`:

Add the import (with the other `./` imports):

```typescript
import { intentToCategory, type SearchIntent } from '../intent'
```

Add `intent` to the `options` type in `search(...)`:

```typescript
    options?: {
      searchMode?: SearchModeOption
      content_types?: SearchContentType[]
      time_range?: 'day' | 'week' | 'month' | 'year'
      // Auto-detected intent (query classifier). Additive: appends ONE
      // category on top of general,images in the general branch below.
      // Ignored in the exclusive academic/social branches by design.
      intent?: SearchIntent
    }
```

In the `else` branch (the non-academic/non-social case), replace the category assembly:

```typescript
        } else {
          // SearXNG accepts a comma-separated category list in one request
          // and tags each result with its own `category` field, so
          // requesting videos/news/it/map/music alongside general/images
          // costs nothing extra — no second round-trip needed.
          //
          // Auto-detected intent adds ONE more category on top (additive:
          // general baseline always fires). Deduped so an intent category
          // already present via content_types isn't repeated.
          const intentCategory = options?.intent
            ? intentToCategory(options.intent)
            : null
          const categoryList = ['general', 'images', ...extraCategories]
          if (intentCategory && !categoryList.includes(intentCategory)) {
            categoryList.push(intentCategory)
          }
          const categories = categoryList.join(',')
          url.searchParams.append('categories', categories)
```

(Leave the rest of the `else` branch — `time_range`, `safesearch`, `engines` — unchanged.)

- [ ] **Step 4: Run to confirm the basic-path tests pass**

Run: `bun run test lib/tools/search/providers/__tests__/searxng.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Thread intent through the search tool and researcher**

In `lib/tools/search.ts`, add to `SearchToolOptions`:

```typescript
export type SearchToolOptions = {
  timeRange?: 'day' | 'week' | 'month' | 'year'
  expandedQueries?: Promise<string[]>
  // Auto-detected intent for this turn (query classifier). Passed to both
  // search paths; additively routes to intent-specific engines.
  intent?: import('./search/providers/intent').SearchIntent
}
```

Wait — correct the import path: the intent module is `lib/tools/search/intent.ts`. Use:

```typescript
  intent?: import('./search/intent').SearchIntent
```

In `search.ts`, pass intent to the **advanced** POST body — in the `fetch(\`${baseUrl}/api/advanced-search\`)` call's JSON body, add:

```typescript
            body: JSON.stringify({
              query: filledQuery,
              maxResults: effectiveMaxResults,
              searchDepth: effectiveSearchDepthForAPI,
              includeDomains: include_domains,
              excludeDomains: exclude_domains,
              timeRange: toolOptions?.timeRange,
              intent: toolOptions?.intent
            })
```

And pass intent to the **basic** searxng provider call — in the `searchAPI === 'searxng'` branch of the provider `.search(...)`, add `intent` to the options object:

```typescript
              {
                searchMode: search_mode as SearchModeOption,
                content_types: content_types as SearchContentType[],
                time_range: toolOptions?.timeRange,
                intent: toolOptions?.intent
              }
```

In `lib/agents/researcher.ts`, add `intent` to `createResearcher`'s params (after `needsRecent`):

```typescript
  // Auto-detected intent from the query classifier for this turn. Forwarded
  // to the search tool so both search paths additively route to
  // intent-specific engines on top of the general baseline.
  intent = 'general',
```

Add it to the destructured params type block:

```typescript
  intent?: import('../tools/search/intent').SearchIntent
```

And forward it into the `createSearchTool` call:

```typescript
    const originalSearchTool = createSearchTool(model, {
      timeRange: needsRecent ? 'month' : undefined,
      expandedQueries: expandedQueriesPromise,
      intent
    })
```

- [ ] **Step 6: Pass classification.intent from both streaming entrypoints**

In `lib/streaming/create-chat-stream-response.ts`, in the `researcher({ … })` call, add after `needsRecent: classification.needsRecent,`:

```typescript
          intent: classification.intent,
```

Do the identical edit in `lib/streaming/create-ephemeral-chat-stream-response.ts` (find its `researcher({ … })` call and add `intent: classification.intent,`).

- [ ] **Step 7: Run the researcher + search test suites**

Run: `bun run test lib/agents/__tests__/researcher.test.ts lib/tools/__tests__/search-to-model-output.test.ts`
Expected: PASS (intent is optional with a `'general'` default, so existing callers are unaffected).

- [ ] **Step 8: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/tools/search.ts lib/agents/researcher.ts lib/streaming/create-chat-stream-response.ts lib/streaming/create-ephemeral-chat-stream-response.ts lib/tools/search/providers/searxng.ts lib/tools/search/providers/__tests__/searxng.test.ts
git commit -m "feat(search): route auto-detected intent to SearXNG engines (basic path + plumbing)"
```

---

## Task 3: Advanced-path intent routing + degoog parity

**Files:**
- Modify: `lib/tools/search/providers/merge-degoog.ts` (add `mergeDegoogIntoSearxngResults`)
- Test: `lib/tools/search/providers/__tests__/merge-degoog.test.ts`
- Modify: `app/api/advanced-search/route.ts` (read intent, append category, query+merge degoog before crawl)

**Interfaces:**
- Consumes: `intentToCategory` (Task 1); existing `fetchDegoogJson`, `resolveDegoogUrl`, `DegoogResult`, `SearXNGResult`.
- Produces: `mergeDegoogIntoSearxngResults(searxngResults: SearXNGResult[], degoogResults: DegoogResult[], maxResults: number): SearXNGResult[]`.

- [ ] **Step 1: Write the failing merge-helper test**

Add to `lib/tools/search/providers/__tests__/merge-degoog.test.ts`:

```typescript
import { mergeDegoogIntoSearxngResults } from '../merge-degoog'
// (add this import alongside the file's existing imports)

describe('mergeDegoogIntoSearxngResults', () => {
  const sx = (url: string, title = 't', content = 'c') => ({ url, title, content })
  const dg = (url: string, title = 'dt', snippet = 'ds') => ({ url, title, snippet })

  it('appends unique degoog web results as SearXNGResult candidates', () => {
    const merged = mergeDegoogIntoSearxngResults(
      [sx('https://a.com/1')],
      [dg('https://b.com/2')],
      10
    )
    const urls = merged.map(r => r.url).sort()
    expect(urls).toEqual(['https://a.com/1', 'https://b.com/2'])
    // degoog snippet becomes SearXNGResult.content
    const b = merged.find(r => r.url === 'https://b.com/2')!
    expect(b.content).toBe('ds')
  })

  it('dedupes a degoog result that duplicates a searxng URL', () => {
    const merged = mergeDegoogIntoSearxngResults(
      [sx('https://a.com/1')],
      [dg('https://a.com/1')],
      10
    )
    expect(merged).toHaveLength(1)
  })

  it('caps the merged candidate pool at maxResults', () => {
    const merged = mergeDegoogIntoSearxngResults(
      [sx('https://a.com/1'), sx('https://a.com/2')],
      [dg('https://b.com/1'), dg('https://b.com/2')],
      3
    )
    expect(merged).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/tools/search/providers/__tests__/merge-degoog.test.ts`
Expected: FAIL — `mergeDegoogIntoSearxngResults` is not exported.

- [ ] **Step 3: Add the merge helper**

In `lib/tools/search/providers/merge-degoog.ts`, add `SearXNGResult` to the type import and export the new helper (reusing the existing `interleaveAndDedupe` + `normalizeUrl` + niche promotion so niche degoog results survive into the crawl candidate slice):

```typescript
// add SearXNGResult to the existing `import type { … } from '@/lib/types'`
```

```typescript
/**
 * Merge degoog WEB results into a SearXNG result list as additional
 * crawl+rerank candidates for the advanced search path. degoog results are
 * converted to the SearXNGResult shape (snippet -> content) and interleaved/
 * deduped by normalized URL, with niche sources promoted so they survive the
 * candidate-pool truncation. Gives the advanced (first, deepest) search the
 * same SearXNG+degoog source union the basic path already has.
 */
export function mergeDegoogIntoSearxngResults(
  searxngResults: SearXNGResult[],
  degoogResults: DegoogResult[],
  maxResults: number
): SearXNGResult[] {
  return interleaveAndDedupe(
    searxngResults,
    degoogResults,
    maxResults,
    (result): SearXNGResult => ({
      title: result.title,
      url: result.url,
      content: result.snippet
    }),
    item => normalizeUrl(item.url)
  )
}
```

(Also add `DegoogResult` to the type import if not already present — it is imported already.)

- [ ] **Step 4: Run to confirm the merge-helper test passes**

Run: `bun run test lib/tools/search/providers/__tests__/merge-degoog.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Wire intent + degoog into the advanced-search route**

In `app/api/advanced-search/route.ts`:

Add imports (with the existing imports):

```typescript
import { fetchDegoogJson } from '@/lib/utils/degoog-client'
import { intentToCategory, type SearchIntent } from '@/lib/tools/search/intent'
import { mergeDegoogIntoSearxngResults, resolveDegoogUrl } from '@/lib/tools/search/providers/merge-degoog'
import type { DegoogResponse } from '@/lib/types'
```

In `POST`, destructure `intent` from the body and thread it into the call + cache key:

```typescript
  const {
    query,
    maxResults,
    searchDepth,
    includeDomains,
    excludeDomains,
    timeRange,
    intent
  } = await request.json()
```

Add intent to the cache key (so `code` and `general` for the same query don't collide) — append `:${typeof intent === 'string' ? intent : ''}` to the existing `cacheKey` template:

```typescript
    const cacheKey = `search:${query}:${maxResults}:${searchDepth}:${
      Array.isArray(includeDomains) ? includeDomains.join(',') : ''
    }:${Array.isArray(excludeDomains) ? excludeDomains.join(',') : ''}:${
      effectiveTimeRange ?? ''
    }:${typeof intent === 'string' ? intent : ''}`
```

Pass intent to `advancedSearchXNGSearch`:

```typescript
    const results = await advancedSearchXNGSearch(
      query,
      Math.min(maxResults, SEARXNG_MAX_RESULTS),
      searchDepth || SEARXNG_DEFAULT_DEPTH,
      Array.isArray(includeDomains) ? includeDomains : [],
      Array.isArray(excludeDomains) ? excludeDomains : [],
      effectiveTimeRange,
      typeof intent === 'string' ? (intent as SearchIntent) : 'general'
    )
```

Update the `advancedSearchXNGSearch` signature (add the `intent` param):

```typescript
async function advancedSearchXNGSearch(
  query: string,
  maxResults: number = 10,
  searchDepth: 'basic' | 'advanced' = 'advanced',
  includeDomains: string[] = [],
  excludeDomains: string[] = [],
  timeRange?: string,
  intent: SearchIntent = 'general'
): Promise<SearXNGSearchResults> {
```

Inside the SearXNG URL builder, append the intent category to the fixed `general,images` list:

```typescript
        const intentCategory = intentToCategory(intent)
        url.searchParams.append(
          'categories',
          intentCategory ? `general,images,${intentCategory}` : 'general,images'
        )
```

(Replace the existing `url.searchParams.append('categories', 'general,images')` line.)

Query degoog concurrently with SearXNG. Replace the single `await fetchSearxngJson(buildUrl)` with a concurrent settle of SearXNG + degoog web (+ degoog news when `intent==='news'`) + degoog images:

```typescript
    const DEGOOG_MAX = Math.min(20, maxResults * 2)
    const degoogUrl = (type: string) => (baseUrl: string) => {
      const u = new URL(`${baseUrl}/api/search`)
      u.searchParams.append('q', query)
      u.searchParams.append('type', type)
      u.searchParams.append('max_results', String(DEGOOG_MAX))
      return u.toString()
    }

    const [searxngSettled, degoogWebSettled, degoogNewsSettled, degoogImgSettled] =
      await Promise.allSettled([
        fetchSearxngJson(buildUrl),
        fetchDegoogJson(degoogUrl('web')),
        intent === 'news'
          ? fetchDegoogJson(degoogUrl('news'))
          : Promise.resolve(null),
        fetchDegoogJson(degoogUrl('images'))
      ])

    if (searxngSettled.status === 'rejected') throw searxngSettled.reason
    const { data: rawData, baseUrlUsed: apiUrl } = searxngSettled.value

    const degoogOf = (
      s: PromiseSettledResult<{ data: unknown } | null>
    ): DegoogResponse['results'] => {
      if (s.status !== 'fulfilled' || !s.value) return []
      return (s.value.data as DegoogResponse).results ?? []
    }
    const degoogWeb = [...degoogOf(degoogWebSettled), ...degoogOf(degoogNewsSettled)]
    const degoogImages = degoogOf(degoogImgSettled)
```

(Remove the old `const { data: rawData, baseUrlUsed: apiUrl } = await fetchSearxngJson(buildUrl)` line — `rawData`/`apiUrl` now come from `searxngSettled.value`. Keep `const data = rawData as SearXNGResponse` and everything after it.)

Merge degoog web results into `generalResults` AFTER domain filtering and BEFORE the `if (searchDepth === 'advanced')` crawl block, so degoog URLs are crawl+rerank candidates:

```typescript
    // degoog parity: fold degoog web results into the candidate pool BEFORE
    // crawl+rerank so the advanced (deepest) search has the same source union
    // as the basic path. Cap at the crawl candidate size so niche degoog
    // results reach the crawler.
    if (degoogWeb.length > 0) {
      generalResults = mergeDegoogIntoSearxngResults(
        generalResults,
        degoogWeb,
        maxResults * SEARXNG_CRAWL_MULTIPLIER
      )
    }
```

Merge degoog images into the returned `images` array (in the `return { … }`). Replace the `images:` field:

```typescript
      images: [
        ...imageResults
          .map((result: SearXNGResult) => {
            const imgSrc = result.img_src || ''
            return imgSrc.startsWith('http') ? imgSrc : `${apiUrl}${imgSrc}`
          })
          .filter(Boolean),
        ...degoogImages
          .map(r =>
            resolveDegoogUrl(
              r.imageUrl || r.thumbnail || '',
              process.env.DEGOOG_API_URL ?? ''
            )
          )
          .filter(Boolean)
      ].slice(0, maxResults),
```

- [ ] **Step 6: Typecheck + full advanced-path-adjacent suites**

Run: `cd /home/nightfury/selfhosted/ask && bun typecheck && bun run test lib/tools/search/providers/__tests__/merge-degoog.test.ts`
Expected: typecheck clean; merge tests PASS. (The route itself is verified in live E2E — it has no unit-test harness in this repo, and mocking Redis + Crawl4AI + two metasearch backends would test the mocks, not the behavior.)

- [ ] **Step 7: Lint, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/tools/search/providers/merge-degoog.ts lib/tools/search/providers/__tests__/merge-degoog.test.ts app/api/advanced-search/route.ts
git commit -m "feat(search): intent routing + degoog parity on the advanced search path"
```

---

## Task 4: Depth tiering

**Files:**
- Modify: `lib/tools/search.ts` (add `firstSearchDepth` option, closure flag, `resolveEffectiveDepth`)
- Create: `lib/tools/__tests__/search-depth-tiering.test.ts`
- Modify: `lib/agents/researcher.ts` (set `firstSearchDepth` per mode)

**Interfaces:**
- Produces: `SearchToolOptions.firstSearchDepth?: 'basic' | 'advanced'`; `resolveEffectiveDepth(opts)` exported from `search.ts`.

- [ ] **Step 1: Write the failing depth-resolution test**

Create `lib/tools/__tests__/search-depth-tiering.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest'

import { resolveEffectiveDepth } from '../search'

describe('resolveEffectiveDepth', () => {
  const base = {
    searchAPI: 'searxng' as const,
    modelRequestedDepth: 'basic' as const,
    envDefaultAdvanced: false,
    firstSearchDepth: 'advanced' as const,
    tieringEnabled: true
  }

  afterEach(() => {
    delete process.env.SEARXNG_DEFAULT_DEPTH
  })

  it('first searxng search of a deep-mode turn runs advanced', () => {
    expect(resolveEffectiveDepth({ ...base, firstSearchDone: false })).toBe(
      'advanced'
    )
  })

  it('subsequent searxng searches are tiered down to basic', () => {
    expect(resolveEffectiveDepth({ ...base, firstSearchDone: true })).toBe(
      'basic'
    )
  })

  it('speed mode (firstSearchDepth basic) stays basic on every search', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        firstSearchDepth: 'basic',
        firstSearchDone: false
      })
    ).toBe('basic')
  })

  it('with tiering off, falls back to env/model-driven depth (advanced)', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        tieringEnabled: false,
        envDefaultAdvanced: true,
        firstSearchDone: true
      })
    ).toBe('advanced')
  })

  it('with tiering off and no env default, uses the model-requested depth', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        tieringEnabled: false,
        modelRequestedDepth: 'advanced',
        firstSearchDone: true
      })
    ).toBe('advanced')
  })

  it('non-searxng providers are unaffected by tiering', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        searchAPI: 'tavily',
        modelRequestedDepth: 'advanced',
        firstSearchDone: true
      })
    ).toBe('advanced')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/tools/__tests__/search-depth-tiering.test.ts`
Expected: FAIL — `resolveEffectiveDepth` is not exported.

- [ ] **Step 3: Add `resolveEffectiveDepth` and the `firstSearchDepth` option**

In `lib/tools/search.ts`:

Add to `SearchToolOptions`:

```typescript
  // Depth for the FIRST search of the turn (set by researcher per mode):
  // 'advanced' for balanced/quality, 'basic' for speed/skip. Depth tiering
  // forces only the first search to this depth, then tiers subsequent
  // searches down to 'basic' — the model deep-reads specific URLs via the
  // fetch tool instead of re-running advanced crawls.
  firstSearchDepth?: 'basic' | 'advanced'
```

Add the exported pure function (near the top of the file, after the imports):

```typescript
// Depth-tiering decision. When enabled (SEARCH_DEPTH_TIERING !== 'off'), the
// FIRST searxng search of a turn uses firstSearchDepth (advanced in deep
// modes) and every later search is forced to basic — capping the expensive
// crawl+rerank to once per turn. When disabled, or for non-searxng
// providers, it reproduces today's behavior exactly (env default beats the
// model-requested depth for searxng; otherwise the model's choice stands).
export function resolveEffectiveDepth(opts: {
  searchAPI: SearchProviderType
  modelRequestedDepth: 'basic' | 'advanced'
  envDefaultAdvanced: boolean
  firstSearchDepth: 'basic' | 'advanced'
  firstSearchDone: boolean
  tieringEnabled: boolean
}): 'basic' | 'advanced' {
  const {
    searchAPI,
    modelRequestedDepth,
    envDefaultAdvanced,
    firstSearchDepth,
    firstSearchDone,
    tieringEnabled
  } = opts

  if (tieringEnabled && searchAPI === 'searxng') {
    return firstSearchDone ? 'basic' : firstSearchDepth
  }

  // Baseline (unchanged): env default forces advanced for searxng; otherwise
  // honor the model-requested depth.
  return searchAPI === 'searxng' && envDefaultAdvanced
    ? 'advanced'
    : modelRequestedDepth
}
```

Add the closure flag inside `createSearchTool` (next to `let expansionUsed = false`):

```typescript
  let firstSearchDone = false
```

Replace the current `effectiveSearchDepthForAPI` computation:

```typescript
      const tieringEnabled = process.env.SEARCH_DEPTH_TIERING !== 'off'
      const effectiveSearchDepthForAPI = resolveEffectiveDepth({
        searchAPI,
        modelRequestedDepth: (effectiveSearchDepth || 'basic') as
          | 'basic'
          | 'advanced',
        envDefaultAdvanced: process.env.SEARXNG_DEFAULT_DEPTH === 'advanced',
        firstSearchDepth: toolOptions?.firstSearchDepth ?? 'basic',
        firstSearchDone,
        tieringEnabled
      })
      // Mark the turn's first search consumed AFTER resolving its depth, so
      // search #1 gets firstSearchDepth and #2+ tier down. (Dedup-skipped
      // searches return before reaching this point and don't consume it.)
      firstSearchDone = true
```

Note: `searchAPI` is currently computed a few lines BELOW this point. Move the `effectiveSearchDepthForAPI` computation to AFTER `searchAPI` is determined (after the `if (type === 'general') { … } else { … }` block that sets `searchAPI`). The `firstSearchDone = true` line goes immediately after the depth resolution.

- [ ] **Step 4: Set `firstSearchDepth` per mode in the researcher**

In `lib/agents/researcher.ts`, compute the first-search depth from the mode/skip state and pass it into `createSearchTool`. Replace the `createSearchTool(model, { … })` call:

```typescript
    // Depth tiering: the first search of a balanced/quality turn goes deep
    // (advanced crawl+rerank); speed and skip turns stay basic. Subsequent
    // searches tier down to basic inside the search tool.
    const firstSearchDepth: 'basic' | 'advanced' =
      skipSearch || searchMode === 'speed' ? 'basic' : 'advanced'

    const originalSearchTool = createSearchTool(model, {
      timeRange: needsRecent ? 'month' : undefined,
      expandedQueries: expandedQueriesPromise,
      intent,
      firstSearchDepth
    })
```

- [ ] **Step 5: Run the depth tests + adjacent suites**

Run: `bun run test lib/tools/__tests__/search-depth-tiering.test.ts lib/agents/__tests__/researcher.test.ts lib/tools/__tests__/search-to-model-output.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/tools/search.ts lib/tools/__tests__/search-depth-tiering.test.ts lib/agents/researcher.ts
git commit -m "feat(search): depth tiering — only first search of a turn runs advanced"
```

---

## Task 5: Search-intent dedup

**Files:**
- Modify: `lib/tools/search.ts` (dedup helper + closure state + skip payload)
- Create: `lib/tools/__tests__/search-dedup.test.ts`

**Interfaces:**
- Produces: `findDuplicateQueryIndex(embedding: number[], priorEmbeddings: number[][], threshold: number): number` exported from `search.ts` (returns the index of the first near-duplicate, or -1).

- [ ] **Step 1: Write the failing dedup-helper test**

Create `lib/tools/__tests__/search-dedup.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { findDuplicateQueryIndex } from '../search'

describe('findDuplicateQueryIndex', () => {
  it('returns -1 when there are no prior embeddings', () => {
    expect(findDuplicateQueryIndex([1, 0, 0], [], 0.92)).toBe(-1)
  })

  it('flags a near-identical vector above threshold', () => {
    // normalized-ish vectors; cosine of [1,0] with [0.99,0.14] ~ 0.99
    expect(
      findDuplicateQueryIndex([1, 0], [[0.99, 0.141]], 0.92)
    ).toBe(0)
  })

  it('does not flag a dissimilar vector below threshold', () => {
    expect(findDuplicateQueryIndex([1, 0], [[0, 1]], 0.92)).toBe(-1)
  })

  it('returns the index of the first prior embedding that matches', () => {
    expect(
      findDuplicateQueryIndex([1, 0], [[0, 1], [1, 0]], 0.92)
    ).toBe(1)
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun run test lib/tools/__tests__/search-dedup.test.ts`
Expected: FAIL — `findDuplicateQueryIndex` is not exported.

- [ ] **Step 3: Add the dedup helper + wire it into the search closure**

In `lib/tools/search.ts`:

Add the import (with the other imports):

```typescript
import {
  cosineSimilarity,
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'
```

Add the exported helper (near `resolveEffectiveDepth`):

```typescript
// Returns the index of the first prior query embedding whose cosine
// similarity to `embedding` meets/exceeds `threshold`, or -1 if none. Used to
// skip near-duplicate query reformulations within a single research turn.
export function findDuplicateQueryIndex(
  embedding: number[],
  priorEmbeddings: number[][],
  threshold: number
): number {
  for (let i = 0; i < priorEmbeddings.length; i++) {
    if (cosineSimilarity(embedding, priorEmbeddings[i]) >= threshold) return i
  }
  return -1
}
```

Add per-turn closure state inside `createSearchTool` (next to `firstSearchDone`):

```typescript
  // Per-turn search-intent dedup state, keyed within a search_mode so a web
  // search and an academic search of the same words aren't treated as dupes.
  const executedQueries: { mode: string; query: string; embedding: number[] }[] =
    []
```

At the very START of `execute` — right after the initial `yield { state: 'searching', query }` and BEFORE any expansion/search work — add the dedup gate:

```typescript
      // Search-intent dedup: skip a near-duplicate reformulation of a query
      // already run this turn. Its results are already in the model's
      // context, so return a short note instead of paying for another
      // search+crawl+rerank. First search never dedups (nothing prior).
      const dedupEnabled = process.env.SEARCH_DEDUP_ENABLED !== 'off'
      if (dedupEnabled && executedQueries.length > 0) {
        try {
          const threshold = Number(
            process.env.SEARCH_DEDUP_THRESHOLD ?? '0.92'
          )
          const [queryEmbedding] = await embedTexts(
            [query],
            getConfiguredModel()
          )
          const priorSameMode = executedQueries.filter(
            e => e.mode === search_mode
          )
          const dupIdx = findDuplicateQueryIndex(
            queryEmbedding,
            priorSameMode.map(e => e.embedding),
            Number.isFinite(threshold) ? threshold : 0.92
          )
          if (dupIdx !== -1) {
            const priorQuery = priorSameMode[dupIdx].query
            console.log(
              `[search-dedup] skipping "${query}" — near-duplicate of "${priorQuery}"`
            )
            yield {
              state: 'complete' as const,
              results: [],
              images: [],
              query,
              number_of_results: 0,
              note: `Skipped: this search is a near-duplicate of an earlier search this turn ("${priorQuery}"). Those results are already above — reuse them, or search a materially different angle instead of rephrasing.`
            }
            return
          }
          // Not a duplicate — record it so later searches compare against it.
          executedQueries.push({
            mode: search_mode,
            query,
            embedding: queryEmbedding
          })
        } catch (error) {
          // Embedding failure ⇒ treat as not-duplicate (search proceeds),
          // never worse than today. Still record the query text so obviously
          // identical strings can be caught cheaply next time.
          console.error('[search-dedup] embedding failed, not deduping:', error)
        }
      } else if (dedupEnabled) {
        // First search of the turn: record it (embed lazily so the first
        // search pays nothing when it's the only one).
        try {
          const [queryEmbedding] = await embedTexts(
            [query],
            getConfiguredModel()
          )
          executedQueries.push({
            mode: search_mode,
            query,
            embedding: queryEmbedding
          })
        } catch (error) {
          console.error('[search-dedup] initial embed failed:', error)
        }
      }
```

Note: `search_mode` is already destructured from the tool params at the top of `execute` (default `'web'`). The `note` field rides through `toModelOutput` automatically (it spreads `output` and only strips `citationMap`/`images`/`state`), so the model sees the skip reason.

- [ ] **Step 4: Run the dedup tests + adjacent suites**

Run: `bun run test lib/tools/__tests__/search-dedup.test.ts lib/tools/__tests__/search-to-model-output.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/tools/search.ts lib/tools/__tests__/search-dedup.test.ts
git commit -m "feat(search): skip near-duplicate query reformulations within a turn"
```

---

## Task 6: Depth-tiering prompt guidance

**Files:**
- Modify: `lib/agents/prompts/search-mode-prompts.ts`
- Test: `lib/agents/prompts/__tests__/search-mode-prompts.test.ts`

**Interfaces:**
- Consumes: nothing new. Adds prose to the balanced + quality prompt builders.

- [ ] **Step 1: Inspect the prompt builders**

Read `lib/agents/prompts/search-mode-prompts.ts` to find the balanced (`getAdaptiveModePrompt`) and quality (`getQualityModePrompt`) prompt strings and the existing test's assertion style.

- [ ] **Step 2: Write the failing test**

Add to `lib/agents/prompts/__tests__/search-mode-prompts.test.ts`:

```typescript
  it('balanced + quality prompts explain depth tiering and fetch-for-depth', () => {
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt.toLowerCase()).toContain('first search')
      expect(prompt.toLowerCase()).toContain('fetch')
    }
  })
```

(Ensure `getAdaptiveModePrompt` and `getQualityModePrompt` are imported in the test file — add them to the existing import from `../search-mode-prompts` if missing.)

- [ ] **Step 3: Run to confirm it fails**

Run: `bun run test lib/agents/prompts/__tests__/search-mode-prompts.test.ts`
Expected: FAIL — the depth-tiering sentence isn't present yet.

- [ ] **Step 4: Add the guidance to both prompts**

In `lib/agents/prompts/search-mode-prompts.ts`, add this sentence to the search-strategy section of BOTH `getAdaptiveModePrompt()` and `getQualityModePrompt()` (place it wherever the prompt already discusses how to search — keep the exact wording so the test matches):

```
Your first search of a turn runs deep (its top results are crawled in full and reranked); follow-up searches return snippets only. To read a specific promising result in full, call the fetch tool on its URL rather than repeating the search for more depth.
```

- [ ] **Step 5: Run to confirm it passes**

Run: `bun run test lib/agents/prompts/__tests__/search-mode-prompts.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd /home/nightfury/selfhosted/ask
bun lint --fix && bun typecheck
git add lib/agents/prompts/search-mode-prompts.ts lib/agents/prompts/__tests__/search-mode-prompts.test.ts
git commit -m "feat(search): teach the model the first-deep / fetch-for-depth pattern"
```

---

## Final verification (whole branch)

- [ ] **Full test suite:** `cd /home/nightfury/selfhosted/ask && bun run test` — all pass.
- [ ] **Lint + types + build:** `bun lint && bun typecheck && bun run build` — all clean.
- [ ] **Staging E2E** (build `admin-feature`, browser-test on `localhost:3739` per the standard staging flow — do NOT push to dev/origin or redeploy production):
  1. **Intent routing (basic + additive):** ask a coding question in balanced mode; confirm via server logs / result mix that `it`-category engines (github/stackoverflow/mdn) appear alongside general results, and that general results are still present (baseline never starved).
  2. **degoog parity on advanced:** confirm the first (advanced) search's logs show degoog results merged into the crawl candidate set (degoog URLs among the reranked results).
  3. **Depth tiering:** in a balanced multi-search turn, confirm exactly ONE `/api/advanced-search` call (advanced) and the rest basic (server logs: `Using search API: searxng … Search Depth: advanced` once, then `basic`).
  4. **Dedup:** ask something that makes the model reformulate a near-identical query; confirm a `[search-dedup] skipping …` log and that the model proceeds without a redundant crawl.
  5. **No regressions:** a plain general question still answers well; a skipSearch clarification still answers from context; user-selected Academic and Social modes still behave exclusively.
- [ ] **Summarize** all changes for the user's review. Do not push or redeploy.

---

## Self-Review (completed)

- **Spec coverage:** Lever 1 → Tasks 1–3; Lever 2 → Tasks 4, 6; Lever 3 → Task 5; degoog parity → Task 3; env toggles/defaults → Tasks 4, 5; SearXNG config changes were already applied (documented in spec, no task needed).
- **Type consistency:** `SearchIntent`/`intentToCategory` defined in Task 1 and consumed identically in Tasks 2, 3; `SearchToolOptions.intent`/`firstSearchDepth` added in Tasks 2/4 and consumed in `researcher.ts`; `resolveEffectiveDepth`/`findDuplicateQueryIndex` exported from `search.ts` and imported by their tests with matching signatures.
- **Placeholder scan:** none — every code step carries complete code.
- **Known deviation from strict TDD:** the advanced-search route wiring (Task 3, Step 5) has no unit test (Redis + Crawl4AI + dual metasearch mocking would test mocks, not behavior); its pure helper IS unit-tested and the route is covered by staging E2E. Called out so the reviewer doesn't flag it as a coverage gap.
