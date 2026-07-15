import { describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  // Score = 1 for passages mentioning "quantum", else 0. Aligns to input order.
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    passages.map(p => (/quantum/i.test(p) ? 1 : 0))
  )
}))

import { rerankByCrossEncoder } from '../rerank'

describe('rerankByCrossEncoder', () => {
  it('orders on-topic docs above off-topic and applies topK', async () => {
    const docs = [
      { content: 'A page about cooking pasta and sauces.', id: 'off' },
      { content: 'An article on quantum computing and qubits.', id: 'on' },
      { content: 'Gardening tips for spring.', id: 'off2' }
    ]
    const out = await rerankByCrossEncoder(docs, 'quantum computers', 2)
    expect(out).toHaveLength(2)
    expect(out[0].doc.id).toBe('on')
    expect(out[0].score).toBeGreaterThan(out[1].score)
    expect(out[0].topPassages.length).toBeGreaterThan(0)
  })

  it('returns [] for empty input', async () => {
    await expect(rerankByCrossEncoder([], 'q', 5)).resolves.toEqual([])
  })
})
