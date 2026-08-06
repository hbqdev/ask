import { describe, expect, it, vi } from 'vitest'

// Bi-encoder stub: a text aligns with the query iff it says "quantum".
vi.mock('../../embeddings/transformers-embedding', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../../embeddings/transformers-embedding')
    >()
  return {
    ...actual,
    embedTexts: vi.fn(async (texts: string[]) =>
      texts.map(t => (/quantum/i.test(t) ? [1, 0] : [0, 1]))
    )
  }
})

import { computeCropPositions } from '../crop-position'

const filler = 'Cooking pasta with tomato and basil sauces is a classic. '
// The answer sentence, placed either early (head) or past the 10k crop (tail).
const ANSWER = 'Quantum computing exploits qubits and superposition to compute.'

describe('computeCropPositions', () => {
  it('flags a source whose best passage was cropped into the tail', async () => {
    const page = filler.repeat(220) + '\n\n' + ANSWER // ANSWER lands past ~12k
    const stat = await computeCropPositions('quantum computing', [
      { url: 'tail', rawContent: page }
    ])
    expect(stat).not.toBeNull()
    expect(stat!.sources).toBe(1)
    expect(stat!.best_in_tail).toBe(1) // most-relevant passage past 10k
    expect(stat!.tail_frac).toBe(1)
    expect(stat!.p50_offset).toBeGreaterThanOrEqual(10000)
  })

  it('does not flag a source whose answer is within the kept head', async () => {
    const page = ANSWER + '\n\n' + filler.repeat(220) // ANSWER at offset 0
    const stat = await computeCropPositions('quantum computing', [
      { url: 'head', rawContent: page }
    ])
    expect(stat!.best_in_tail).toBe(0)
    expect(stat!.tail_frac).toBe(0)
    expect(stat!.p50_offset).toBeLessThan(10000)
  })

  it('returns null for no usable sources', async () => {
    await expect(computeCropPositions('q', [])).resolves.toBeNull()
    await expect(
      computeCropPositions('q', [{ url: 'x', rawContent: '' }])
    ).resolves.toBeNull()
  })
})
