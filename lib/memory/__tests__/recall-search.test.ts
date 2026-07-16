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

import { recallSearch } from '../recall-search'

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
