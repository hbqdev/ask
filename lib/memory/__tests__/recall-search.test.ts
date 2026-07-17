import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async () => [new Array(1024).fill(0.1)]),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/recall-actions', () => ({
  vectorSearchChunks: vi.fn(async () => []),
  keywordSearchChunks: vi.fn(async () => []),
  isRecallEnabled: vi.fn(async () => true)
}))
vi.mock('@/lib/utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => false),
  crossEncoderScore: vi.fn(async () => [])
}))

import * as db from '@/lib/db/recall-actions'
import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '@/lib/utils/cross-encoder'

import { recallSearch, selectRerankCandidates } from '../recall-search'

const row = (over: Partial<any> = {}) => ({
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: '3-2-1 rule',
  createdAt: new Date('2026-07-01'),
  score: 0.9,
  ...over
})

describe('selectRerankCandidates', () => {
  const vec = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row({ chunkId: `v${i}`, score: 1 - i / 100 })
    )
  const kw = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ chunkId: `k${i}`, score: 0 }))

  it('caps the pool at the requested size', () => {
    expect(selectRerankCandidates(vec(30), kw(30), 20)).toHaveLength(20)
  })

  it('keeps keyword-only hits that a top-N-by-score cut would discard', () => {
    // The regression this guards: keyword-only hits carry score 0, so any
    // "sort the union by score, take the top N" cap drops all of them once
    // the vector arm alone fills N — silently reducing the hybrid to its
    // vector arm. The vector arm returns up to 30, so that is always.
    const picked = selectRerankCandidates(vec(30), kw(30), 20)
    const keywordOnly = picked.filter(h => h.chunkId.startsWith('k'))
    expect(keywordOnly).toHaveLength(5)
    expect(picked.filter(h => h.chunkId.startsWith('v'))).toHaveLength(15)
  })

  it('gives the whole pool to the vector arm when no keyword-only hits exist', () => {
    const picked = selectRerankCandidates(vec(30), [], 20)
    expect(picked).toHaveLength(20)
    expect(picked.every(h => h.chunkId.startsWith('v'))).toBe(true)
  })

  it('does not reserve slots for keyword hits the vector arm already found', () => {
    // Same chunk in both arms is not a "keyword-only" hit — it must not
    // consume reserve, or the pool loses vector candidates for nothing.
    const overlap = [row({ chunkId: 'v0', score: 0 })]
    const picked = selectRerankCandidates(vec(30), overlap, 20)
    expect(picked).toHaveLength(20)
    expect(picked.every(h => h.chunkId.startsWith('v'))).toBe(true)
  })

  it("preserves each arm's ordering (vector by cosine, keyword by recency)", () => {
    const picked = selectRerankCandidates(vec(30), kw(30), 20)
    expect(picked.slice(0, 3).map(h => h.chunkId)).toEqual(['v0', 'v1', 'v2'])
    expect(picked.slice(15).map(h => h.chunkId)).toEqual([
      'k0',
      'k1',
      'k2',
      'k3',
      'k4'
    ])
  })

  it('returns everything when the arms are smaller than the pool', () => {
    expect(selectRerankCandidates(vec(3), kw(2), 20)).toHaveLength(5)
  })
})

describe('recallSearch', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so each test starts from the
    // vi.mock() factory defaults — clearAllMocks only wipes call history,
    // it leaves a prior test's mockResolvedValue() implementation in place,
    // which otherwise leaks stub results (e.g. a stray keyword-arm hit)
    // across unrelated tests.
    vi.resetAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
  })

  it('unions both arms and dedups by chunk id (vector score wins)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([row({ score: 0.9 })])
    vi.mocked(db.keywordSearchChunks).mockResolvedValue([row({ score: 0 })])
    const hits = await recallSearch('u1', 'backups', {
      topK: 5,
      useRerank: false
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].score).toBe(0.9)
  })

  it('applies minScore as a cosine gate when not reranking', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.5 })
    ])
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      minScore: 0.75
    })
    expect(hits.map(h => h.chunkId)).toEqual(['a'])
  })

  it('reranks and overwrites score when the cross-encoder is configured', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue([0.1, 0.99])
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['b', 'a'])
    expect(hits[0].score).toBe(0.99)
  })

  it('sends the capped candidate set to the reranker, not the full union', async () => {
    // Pins the cost bound: both arms return up to 30 rows each, so an
    // uncapped union would rerank ~60 passages (measured 7.6s against a 10s
    // timeout). RECALL_RERANK_POOL defaults to 20.
    vi.mocked(db.vectorSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        row({ chunkId: `v${i}`, score: 1 - i / 100 })
      )
    )
    vi.mocked(db.keywordSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => row({ chunkId: `k${i}`, score: 0 }))
    )
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue(new Array(20).fill(0.5))

    await recallSearch('u1', 'q', { topK: 2, useRerank: true })

    const passages = vi.mocked(crossEncoderScore).mock.calls[0][1]
    expect(passages).toHaveLength(20)
  })

  it('does not cap the non-rerank path (the cap only bounds rerank cost)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        row({ chunkId: `v${i}`, score: 1 - i / 100 })
      )
    )
    const hits = await recallSearch('u1', 'q', { topK: 50, useRerank: false })
    expect(hits).toHaveLength(30)
  })

  it('falls back to cosine order when the reranker throws (no minScore)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockRejectedValue(new Error('reranker down'))
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['a', 'b'])
  })

  it('filters on the RERANK scale once rerank actually runs', async () => {
    // Cosine-sorted order going into rerank is [a (0.9), b (0.8)].
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    // Rerank inverts the cosine order: 'a' (cosine-favored) scores low on
    // rerank (0.001, below minScore), 'b' scores high (0.2, above) —
    // proves the filter reads the post-rerank score, not the pre-rerank
    // cosine score.
    vi.mocked(crossEncoderScore).mockResolvedValue([0.001, 0.2])
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits.map(h => h.chunkId)).toEqual(['b'])
  })

  it('fails closed to [] when useRerank+minScore is requested but the cross-encoder is unconfigured', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits).toEqual([])
  })

  it('fails closed to [] when useRerank+minScore is requested but crossEncoderScore throws', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockRejectedValue(new Error('reranker down'))
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits).toEqual([])
  })

  it('passes excludeChatId to both arms', async () => {
    await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      excludeChatId: 'c9'
    })
    expect(db.vectorSearchChunks).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      30,
      'c9'
    )
    expect(db.keywordSearchChunks).toHaveBeenCalledWith('u1', 'q', 30, 'c9')
  })

  it('is inert when recall is disabled, and never throws on error', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(
      await recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).toEqual([])
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(db.vectorSearchChunks).mockRejectedValue(new Error('db down'))
    await expect(
      recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).resolves.toEqual([])
  })
})
