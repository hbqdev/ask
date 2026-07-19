import { describe, expect, it, vi } from 'vitest'

import { rerankByEmbedding } from '../rerank'

// Deterministic fake embeddings: the "query" and on-topic passages share a
// direction; off-topic passages are orthogonal. Keeps the test independent
// of the real transformers pipeline (which downloads a model).
vi.mock('../transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) =>
    texts.map(t => (t.includes('quantum') ? [1, 0] : [0, 1]))
  ),
  cosineSimilarity: (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1]
}))

describe('rerankByEmbedding', () => {
  it('orders on-topic documents above off-topic ones and applies topK', async () => {
    const docs = [
      { content: 'A page all about cooking pasta and sauces.', id: 'off' },
      { content: 'An article on quantum computing and qubits.', id: 'on' },
      { content: 'Another page about gardening tips.', id: 'off2' }
    ]

    const reranked = await rerankByEmbedding(docs, 'quantum computers', 2)

    expect(reranked).toHaveLength(2)
    expect(reranked[0].doc.id).toBe('on')
    expect(reranked[0].score).toBeGreaterThan(reranked[1].score)
    expect(reranked[0].topPassages.length).toBeGreaterThan(0)
  })

  it('returns empty for empty input', async () => {
    await expect(rerankByEmbedding([], 'anything', 5)).resolves.toEqual([])
  })
})
