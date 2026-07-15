import { describe, expect, it } from 'vitest'

import { findDuplicateQueryIndex } from '../search'

describe('findDuplicateQueryIndex', () => {
  it('returns -1 when there are no prior embeddings', () => {
    expect(findDuplicateQueryIndex([1, 0, 0], [], 0.92)).toBe(-1)
  })

  it('flags a near-identical vector above threshold', () => {
    // normalized-ish vectors; cosine of [1,0] with [0.99,0.14] ~ 0.99
    expect(findDuplicateQueryIndex([1, 0], [[0.99, 0.141]], 0.92)).toBe(0)
  })

  it('does not flag a dissimilar vector below threshold', () => {
    expect(findDuplicateQueryIndex([1, 0], [[0, 1]], 0.92)).toBe(-1)
  })

  it('returns the index of the first prior embedding that matches', () => {
    expect(
      findDuplicateQueryIndex(
        [1, 0],
        [
          [0, 1],
          [1, 0]
        ],
        0.92
      )
    ).toBe(1)
  })
})
