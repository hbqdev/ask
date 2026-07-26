# Source Excerpts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the answering model each source's top-ranked passages in document order instead of the full crawled page, cutting a research prompt from ~82,000 tokens to ~17,000 while returning the same 15 sources.

**Architecture:** The reranker already splits every document into 256-token passages and scores them, but returns the best three in _score_ order and the search route discards them entirely. Track each passage's document index, restore document order after score-based selection, join the kept passages with a gap-aware elision marker in a pure helper, and have the search route use that as the source's `content` behind an env flag.

**Tech Stack:** TypeScript, Next.js 16 App Router, Vitest, Bun.

## Global Constraints

- Run tests with `bun run test` — never `bun test` (that is Bun's runner, which lacks Vitest features).
- Format single files with `bunx prettier --write <file>` — never repo-wide `bun run format`.
- Before any commit: `bun lint` (0 errors), `bun typecheck`, `bun format:check`, `bun run test`, `bun run build` must all pass. `bun run build` requires `DATABASE_URL` to be set; if it is not in your shell, prefix with `DATABASE_URL="postgres://build:build@127.0.0.1:5432/build"`.
- Never add `Co-Authored-By` or any AI-attribution trailer to a commit message.
- Do not push to any git remote. Do not touch production. This work is staging-only.
- `PASSAGES_PER_SOURCE` default is `3`. `SEARCH_EXCERPTS_ENABLED` default is off (unset or anything other than the exact string `true`).
- The existing rerank tier fallback chain (cross-encoder → embedding → keyword) must keep working unchanged. A reranker outage must not become a content regression.

## File Structure

| File                                                             | Responsibility                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `lib/embeddings/rerank.ts` (modify)                              | Split docs into passages, score them, select top N by score, return them **in document order** with their indices.                  |
| `lib/search/build-excerpt.ts` (create)                           | Pure function: turn ranked passages into one content string, inserting an elision marker only where document indices actually skip. |
| `lib/search/__tests__/build-excerpt.test.ts` (create)            | Unit tests for the joiner — ordering, gaps, adjacency, empty fallback.                                                              |
| `lib/embeddings/__tests__/rerank-passage-order.test.ts` (create) | Proves selection stays score-based while presentation becomes positional.                                                           |
| `app/api/advanced-search/route.ts` (modify)                      | `applyReranked` builds `content` from passages when the flag is on.                                                                 |

`lib/search/` does not exist yet; Task 2 creates it.

---

### Task 1: Passage index tracking and document-order restoration

**Files:**

- Modify: `lib/embeddings/rerank.ts:26-30` (constants), `:36-41` (types), `:57-86` (`rerankByPassageScorer`)
- Test: `lib/embeddings/__tests__/rerank-passage-order.test.ts` (create)

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces: `export type RankedPassage = { text: string; index: number }` and `RerankedDoc<T>.topPassages: RankedPassage[]` (document order, ascending `index`). Tasks 2 and 3 both depend on this exact shape.

**Context you need:** `rerankByPassageScorer` is a private helper shared by both public rerankers (`rerankByEmbedding`, `rerankByCrossEncoder`), so this change lands in one place and both tiers get it. Today it does `passageScores.sort((a, b) => b.score - a.score)` then `.slice(0, 3)`, so `topPassages` comes back best-first rather than in reading order. Nothing has ever consumed the field, so nothing caught it.

- [ ] **Step 1: Write the failing test**

Create `lib/embeddings/__tests__/rerank-passage-order.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

// Score by marker word so the ranking is fully deterministic and independent
// of any real model. OMEGA (late in the document) outscores ALPHA (early),
// so score-ordered output would put OMEGA first — document order must not.
vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    passages.map(p => {
      if (p.includes('OMEGA')) return 1
      if (p.includes('ALPHA')) return 0.9
      return 0
    })
  )
}))

import { rerankByCrossEncoder } from '../rerank'

// Each sentence is ~65 tokens, so passages (256 tokens) hold ~4 sentences.
// Markers sit far enough apart to land in different passages.
function sentence(marker: string): string {
  return `${marker} ${'filler '.repeat(60)}. `
}

const document =
  sentence('ALPHA') +
  Array.from({ length: 12 }, () => sentence('plain')).join('') +
  sentence('OMEGA')

describe('rerankByPassageScorer passage ordering', () => {
  it('returns kept passages in document order, not score order', async () => {
    const out = await rerankByCrossEncoder([{ content: document }], 'q', 1)

    const indices = out[0].topPassages.map(p => p.index)
    // The invariant: ascending document position.
    expect(indices).toEqual([...indices].sort((a, b) => a - b))

    // And specifically: the early high scorer precedes the late top scorer.
    const text = out[0].topPassages.map(p => p.text).join('\n')
    expect(text.indexOf('ALPHA')).toBeLessThan(text.indexOf('OMEGA'))
  })

  it('still SELECTS by score — the kept set is the best passages', async () => {
    const out = await rerankByCrossEncoder([{ content: document }], 'q', 1)
    const kept = out[0].topPassages.map(p => p.text).join(' ')
    expect(kept).toContain('OMEGA')
    expect(kept).toContain('ALPHA')
  })

  it('reports the best passage score, unaffected by the re-sort', async () => {
    const out = await rerankByCrossEncoder([{ content: document }], 'q', 1)
    expect(out[0].score).toBe(1)
  })

  it('gives each passage the index of its position in the document', async () => {
    const out = await rerankByCrossEncoder([{ content: document }], 'q', 1)
    for (const p of out[0].topPassages) {
      expect(Number.isInteger(p.index)).toBe(true)
      expect(p.index).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps PASSAGES_PER_SOURCE passages at most', async () => {
    const out = await rerankByCrossEncoder([{ content: document }], 'q', 1)
    expect(out[0].topPassages.length).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test lib/embeddings/__tests__/rerank-passage-order.test.ts`

Expected: FAIL. `topPassages` is currently `string[]`, so `p.index` is `undefined` and the ordering assertion fails.

- [ ] **Step 3: Add the type and the count constant**

In `lib/embeddings/rerank.ts`, replace the `RerankedDoc` type block (currently lines 36-41) with:

```ts
/** A passage kept for a document, with its position in that document. */
export type RankedPassage = {
  text: string
  index: number
}

export type RerankedDoc<T> = {
  doc: T
  score: number
  /**
   * The best passages for this document, in DOCUMENT order. Selection is by
   * score; presentation is positional, because these are concatenated into
   * the answering prompt and shuffled paragraphs read as nonsense.
   */
  topPassages: RankedPassage[]
}
```

Then add, next to `MAX_PASSAGES_PER_DOC` (near line 30):

```ts
// How many of a document's best passages are kept for the prompt.
function passagesPerSource(): number {
  const raw = Number(process.env.PASSAGES_PER_SOURCE)
  if (!Number.isFinite(raw) || raw < 1) return 3
  return Math.min(Math.floor(raw), MAX_PASSAGES_PER_DOC)
}
```

- [ ] **Step 4: Restore document order in the scorer**

In `lib/embeddings/rerank.ts`, replace the body of the `docs.map` inside `rerankByPassageScorer` (currently lines 69-83) with:

```ts
let cursor = 0
const keep = passagesPerSource()
const scored: RerankedDoc<T>[] = docs.map((doc, i) => {
  const passages = passagesPerDoc[i]
  const passageScores = passages.map((passage, j) => ({
    text: passage,
    index: j,
    score: scores[cursor + j] ?? 0
  }))
  cursor += passages.length

  const byScore = [...passageScores].sort((a, b) => b.score - a.score)
  const topPassages = byScore
    .slice(0, keep)
    // Select by score, then present in reading order.
    .sort((a, b) => a.index - b.index)
    .map(({ text, index }) => ({ text, index }))

  return {
    doc,
    score: byScore[0]?.score ?? 0,
    topPassages
  }
})
```

Note `byScore` is a copy — `passageScores` must not be sorted in place, or `index` would no longer correspond to position for anything reading it later.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `bun run test lib/embeddings/__tests__/rerank-passage-order.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the existing rerank tests to confirm no regression**

Run: `bun run test lib/embeddings/`

Expected: PASS. The two existing assertions are `expect(out[0].topPassages.length).toBeGreaterThan(0)`, which still hold for an array of objects.

- [ ] **Step 7: Verify and commit**

```bash
bunx prettier --write lib/embeddings/rerank.ts lib/embeddings/__tests__/rerank-passage-order.test.ts
bun lint && bun typecheck && bun run test
git add lib/embeddings/rerank.ts lib/embeddings/__tests__/rerank-passage-order.test.ts
git commit -m "fix(rerank): return top passages in document order with indices

topPassages was sorted by score then sliced, so it came back best-first
rather than in reading order. Nothing caught it because nothing consumed the
field. It is about to be concatenated into the answering prompt, where
shuffled paragraphs read as nonsense.

Selection stays score-based; presentation becomes positional. Each passage
now carries its document index so a consumer can tell adjacent passages from
elided ones. Kept count is configurable via PASSAGES_PER_SOURCE (default 3)."
```

---

### Task 2: The gap-aware excerpt joiner

**Files:**

- Create: `lib/search/build-excerpt.ts`
- Test: `lib/search/__tests__/build-excerpt.test.ts` (create)

**Interfaces:**

- Consumes: `RankedPassage` from `lib/embeddings/rerank.ts` (Task 1) — `{ text: string; index: number }`.
- Produces: `buildExcerptContent(passages: RankedPassage[], fallback: string): string`. Task 3 calls this.

**Context you need:** Passages are 256-token slices with 32 tokens of overlap. Two passages with consecutive indices are contiguous text and must read as continuous prose. Two with a gap between them have real elided content, and the model needs to be told, or it will read a conclusion across the seam. Writing a marker between every pair would assert an elision that does not exist.

- [ ] **Step 1: Write the failing test**

Create `lib/search/__tests__/build-excerpt.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { buildExcerptContent } from '../build-excerpt'

describe('buildExcerptContent', () => {
  it('joins adjacent passages as continuous prose, with no elision marker', () => {
    const out = buildExcerptContent(
      [
        { text: 'first part', index: 0 },
        { text: 'second part', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('first part\nsecond part')
    expect(out).not.toContain('[…]')
  })

  it('marks the elision when passages skip document positions', () => {
    const out = buildExcerptContent(
      [
        { text: 'opening', index: 0 },
        { text: 'much later', index: 7 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('opening\n[…]\nmuch later')
  })

  it('marks only the real gaps in a mixed run', () => {
    const out = buildExcerptContent(
      [
        { text: 'a', index: 2 },
        { text: 'b', index: 3 },
        { text: 'c', index: 9 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('a\nb\n[…]\nc')
  })

  it('falls back to the original content when there are no passages', () => {
    // A document that produced no passages, or a rerank tier that scores no
    // passages at all, must keep its full text rather than become empty.
    expect(buildExcerptContent([], 'FALLBACK')).toBe('FALLBACK')
  })

  it('sorts defensively by index rather than trusting call order', () => {
    const out = buildExcerptContent(
      [
        { text: 'later', index: 5 },
        { text: 'earlier', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('earlier\n[…]\nlater')
  })

  it('returns a single passage with no marker at all', () => {
    expect(buildExcerptContent([{ text: 'only', index: 4 }], 'FALLBACK')).toBe(
      'only'
    )
  })

  it('drops blank passages instead of emitting stray markers', () => {
    const out = buildExcerptContent(
      [
        { text: 'real', index: 0 },
        { text: '   ', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('real')
  })

  it('falls back when every passage is blank', () => {
    expect(buildExcerptContent([{ text: '  ', index: 0 }], 'FALLBACK')).toBe(
      'FALLBACK'
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test lib/search/__tests__/build-excerpt.test.ts`

Expected: FAIL with `Failed to resolve import "../build-excerpt"`.

- [ ] **Step 3: Write the implementation**

Create `lib/search/build-excerpt.ts`:

```ts
// Turns a document's kept passages into the single content string that goes
// to the answering model.
//
// Why a separate module: the search route is a long handler that needs a live
// SearXNG, a crawler and a reranker to exercise. Ordering, gap detection and
// the empty case are exactly the logic most likely to be subtly wrong, so
// they live here where they are testable in isolation.

import type { RankedPassage } from '../embeddings/rerank'

/** Signals to the model that text was omitted between two passages. */
const ELISION = '[…]'

/**
 * Join passages in document order, inserting an elision marker only where
 * their indices actually skip. Adjacent passages are contiguous text and are
 * joined as continuous prose.
 *
 * Returns `fallback` when there is nothing usable to join, so a document that
 * produced no passages keeps its original content instead of going empty.
 */
export function buildExcerptContent(
  passages: RankedPassage[],
  fallback: string
): string {
  const usable = passages
    .filter(p => p.text.trim().length > 0)
    // Defensive: correctness here must not depend on the caller's ordering.
    .sort((a, b) => a.index - b.index)

  if (usable.length === 0) return fallback

  let out = usable[0].text
  for (let i = 1; i < usable.length; i++) {
    const gap = usable[i].index - usable[i - 1].index > 1
    out += (gap ? `\n${ELISION}\n` : '\n') + usable[i].text
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test lib/search/__tests__/build-excerpt.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 5: Verify and commit**

```bash
bunx prettier --write lib/search/build-excerpt.ts lib/search/__tests__/build-excerpt.test.ts
bun lint && bun typecheck && bun run test
git add lib/search/build-excerpt.ts lib/search/__tests__/build-excerpt.test.ts
git commit -m "feat(search): add gap-aware excerpt joiner

Joins a document's kept passages in reading order, inserting an elision
marker only where their indices actually skip — adjacent passages are
contiguous text and joining them with a marker would assert a gap that is not
there. Falls back to the original content when no usable passage exists, so a
document that produced none keeps its full text rather than going empty."
```

---

### Task 3: Use excerpts as source content behind a flag

**Files:**

- Modify: `app/api/advanced-search/route.ts:867-874` (`applyReranked`)
- Modify: `app/api/advanced-search/route.ts` import block (top of file)

**Interfaces:**

- Consumes: `buildExcerptContent(passages, fallback)` from Task 2; `RankedPassage` from Task 1.
- Produces: no new exports. The route's response shape stays `{ title, url, content }`.

**Context you need:** `applyReranked` is called from two places — the cross-encoder tier (floor `0.1`) and the embedding tier (floor `0.2`). Both pass the output of a `rerankByPassageScorer`-based reranker, so both now carry `topPassages`. The third tier (keyword scorer, in the `catch`) builds `generalResults` directly and never calls `applyReranked`, so it keeps full content with no change — which is the required degradation behaviour.

`docsForRerank` strips `<mark>` tags before scoring, so passages carry no highlight markup while `doc.original.content` does. That is fine and slightly better: `components/search-results.tsx:63` renders `{result.content}` as escaped text, so literal `<mark>` strings currently show through in the snippet.

- [ ] **Step 1: Add both imports**

In `app/api/advanced-search/route.ts`, add to the import block at the top of the file:

```ts
import type { RankedPassage } from '@/lib/embeddings/rerank'
import { buildExcerptContent } from '@/lib/search/build-excerpt'
```

Then run `bun lint --fix` to sort them into position.

- [ ] **Step 2: Replace `applyReranked`**

Match on the code below, not on a line number — Step 1 has already shifted the file. Find the `const applyReranked = (` declaration (it is the only one) and replace this exact block:

```ts
const applyReranked = (
  reranked: { doc: { original: SearXNGResult }; score: number }[],
  minScore: number
) => {
  generalResults = reranked
    .filter(r => r.score >= minScore)
    .map(r => r.doc.original)
}
```

with:

```ts
// Send the model each source's top-ranked passages rather than the whole
// page. Measured: a research turn's prompt is ~82k tokens against ~6k for
// a non-search turn on the same conversation, i.e. ~93% of the prompt is
// crawled page text, costing 6.6-13.7s of prompt processing before the
// first word appears. Source COUNT is unchanged — this trims bytes per
// source, not sources.
const excerptsEnabled = process.env.SEARCH_EXCERPTS_ENABLED === 'true'
const applyReranked = (
  reranked: {
    doc: { original: SearXNGResult }
    score: number
    topPassages: RankedPassage[]
  }[],
  minScore: number
) => {
  generalResults = reranked
    .filter(r => r.score >= minScore)
    .map(r =>
      excerptsEnabled
        ? {
            ...r.doc.original,
            content: buildExcerptContent(r.topPassages, r.doc.original.content)
          }
        : r.doc.original
    )
}
```

- [ ] **Step 3: Verify the whole suite and the build**

```bash
bun lint && bun typecheck && bun format:check && bun run test
DATABASE_URL="${DATABASE_URL:-postgres://build:build@127.0.0.1:5432/build}" bun run build
```

Expected: lint 0 errors, typecheck silent, format clean, all tests pass, build completes with a route listing.

`bun run build` is required, not optional — a missing package in `serverExternalPackages` has broken this repo's build before while every other check passed.

- [ ] **Step 4: Commit**

```bash
git add app/api/advanced-search/route.ts
git commit -m "feat(search): send ranked passages as source content behind a flag

A research turn sends ~82k prompt tokens against ~6k for a non-search turn on
the same conversation — ~93% of the prompt is crawled page text, and it buys
6.6-13.7s of prompt processing before the first word appears.

applyReranked now builds each source's content from the passages the reranker
already scored and returned. Source count, ordering and URLs are untouched;
this trims bytes per source. Off by default (SEARCH_EXCERPTS_ENABLED) so the
A/B runs against one build and a quality problem is an env var away from
reverting. The keyword fallback tier never calls applyReranked and so keeps
full content, as required."
```

---

### Task 4: Enable on staging and verify

**Files:**

- Modify: `docker-compose.admin-feature.yaml` (staging environment block)

**Interfaces:**

- Consumes: the flag read in Task 3 (`SEARCH_EXCERPTS_ENABLED`).
- Produces: a running staging deployment with excerpts on.

**Context you need:** Staging is the `ask-admin-feature` container on port 3739, brought up with both compose files. Production is port 3738 and is **out of scope** — do not rebuild it, do not push to any remote.

- [ ] **Step 1: Add the flag to the staging compose environment**

In `docker-compose.admin-feature.yaml`, inside the `ask` service's `environment:` block, add:

```yaml
- SEARCH_EXCERPTS_ENABLED=true
```

- [ ] **Step 2: Rebuild staging**

```bash
cd /home/nightfury/selfhosted/ask
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d --build ask
```

- [ ] **Step 3: Wait for staging to answer**

```bash
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://192.168.50.231:3739/)
  [ "$code" = "200" ] && { echo "staging up"; break; }
  sleep 5
done
```

Expected: `staging up`.

- [ ] **Step 4: Flush the search cache so the test does not read pre-change results**

```bash
docker exec ask-redis-admin-feature redis-cli --scan --pattern 'search:*' \
  | while read -r k; do docker exec ask-redis-admin-feature redis-cli DEL "$k" >/dev/null; done
echo flushed
```

- [ ] **Step 5: Confirm the flag reached the container**

```bash
docker exec ask-admin-feature printenv SEARCH_EXCERPTS_ENABLED
```

Expected: `true`. If this prints nothing, the compose edit did not take effect and every later measurement would silently be a control run.

- [ ] **Step 6: Commit the compose change**

```bash
git add docker-compose.admin-feature.yaml
git commit -m "chore(staging): enable source excerpts on staging

Staging only. Production is untouched and stays on full-page content until
the A/B in the spec has been read."
```

---

## Verification (run by the orchestrator, not a task subagent)

Per the spec's Verification section. Browser only, one conversation, varied questions.

**Latency** — from the `[latency]` line, comparing against the pre-change baseline in the spec:

- `prompt_tokens` — expect a large, unambiguous drop from ~82,000.
- `stream["text-start"] - stream["finish-step"]` — the search-to-first-prose interval this change targets (baseline 6.6s / 13.7s / 9.1s).
- `total_ms`.

**Quality** — the part telemetry cannot see:

- The returned URL list must be unchanged versus a control run. Excerpting happens strictly after ranking, so different sources means the change leaked into selection and is a bug, not a tradeoff.
- For each citation in an answer, confirm the cited claim is supported by text actually present in that source's passages. This is the failure mode that renders normally and is invisible in any metric.
- Ask at least one question whose answer needs a table or a multi-step procedure, to probe passage fragmentation.

**Stop condition:** if citations lose support, raise `PASSAGES_PER_SOURCE` before abandoning the approach — the passages are ranked, so more of them is a dial, not a redesign.
