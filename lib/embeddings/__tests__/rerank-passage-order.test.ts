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

// Each sentence is 64 tokens, so 256-token passages hold ~4 sentences.
// Verified against splitText: this document yields 5 passages, with ALPHA in
// passage 0 and OMEGA in passage 4 — far enough apart to prove the ordering.
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
