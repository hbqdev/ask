import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cross-encoder returns whatever score the test stashes here, keyed by the
// chunk content, so each case controls the FINAL rank score precisely.
const crossScores = new Map<string, number>()

vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    passages.map(p => crossScores.get(p) ?? 0)
  )
}))

// Cosine controls the fallback (reranker-off) path. Default: every chunk
// equally "close" so the candidate pool is just insertion order.
const cosineImpl = { fn: (_a: number[], _b: number[]) => 1 }
vi.mock('../transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  cosineSimilarity: (a: number[], b: number[]) => cosineImpl.fn(a, b),
  getConfiguredModel: () => 'Xenova/all-MiniLM-L6-v2'
}))

import { isCrossEncoderConfigured } from '../../utils/cross-encoder'
import { rankChunks } from '../upload-rag'

function chunk(content: string) {
  return { content, embedding: [1, 0] }
}

describe('rankChunks — RAG_MIN_SCORE relevance floor', () => {
  const prev = process.env.RAG_MIN_SCORE

  beforeEach(() => {
    crossScores.clear()
    cosineImpl.fn = () => 1
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    delete process.env.RAG_MIN_SCORE // exercise the default (0.01)
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.RAG_MIN_SCORE
    else process.env.RAG_MIN_SCORE = prev
    vi.clearAllMocks()
  })

  it('drops chunks below the floor and keeps those at/above it (cross-encoder scale)', async () => {
    crossScores.set('relevant high', 0.2)
    crossScores.set('off-topic low', 0.005) // below default 0.01
    crossScores.set('relevant marginal', 0.15)

    const out = await rankChunks(
      'q',
      [chunk('relevant high'), chunk('off-topic low'), chunk('relevant marginal')],
      [1, 0],
      10
    )

    expect(out).toEqual(['relevant high', 'relevant marginal'])
    expect(out).not.toContain('off-topic low')
  })

  it('returns [] when NO chunk clears the floor (off-topic doc contributes nothing)', async () => {
    crossScores.set('unrelated a', 0.0001)
    crossScores.set('unrelated b', 0.0000164)

    const out = await rankChunks(
      'totally unrelated question',
      [chunk('unrelated a'), chunk('unrelated b')],
      [1, 0],
      10
    )

    expect(out).toEqual([])
  })

  it('RAG_MIN_SCORE=0 fully disables the floor (returns the top-K unfiltered)', async () => {
    process.env.RAG_MIN_SCORE = '0'
    crossScores.set('near-zero a', 0.0001)
    crossScores.set('near-zero b', 0)

    const out = await rankChunks(
      'q',
      [chunk('near-zero a'), chunk('near-zero b')],
      [1, 0],
      10
    )

    // Nothing dropped even though both are far below the usual floor.
    expect(out.sort()).toEqual(['near-zero a', 'near-zero b'])
  })

  it('honours an operator-set floor value', async () => {
    process.env.RAG_MIN_SCORE = '0.5'
    crossScores.set('above', 0.6)
    crossScores.set('below', 0.3)

    const out = await rankChunks('q', [chunk('above'), chunk('below')], [1, 0], 10)

    expect(out).toEqual(['above'])
  })

  it('correct scale gating: the cross-encoder-scale floor is NOT applied on the cosine fallback path', async () => {
    // Reranker unavailable → scores stay on the COSINE scale (here 0.005),
    // which is numerically below the rerank-scale floor but is a different
    // scale entirely. The floor must NOT drop these — fail OPEN so an
    // explicitly attached doc still contributes when the reranker is down.
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
    cosineImpl.fn = () => 0.005 // below default 0.01, but on the cosine scale

    const out = await rankChunks(
      'q',
      [chunk('cosine only a'), chunk('cosine only b')],
      [1, 0],
      10
    )

    expect(out.sort()).toEqual(['cosine only a', 'cosine only b'])
  })
})
