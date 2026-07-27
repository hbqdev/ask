import { describe, expect, it } from 'vitest'

import { buildReturnedRanks } from '../returned-ranks'

describe('buildReturnedRanks', () => {
  it('maps each returned url to its pre-crawl rank', () => {
    const ranks = new Map([
      ['https://a.example', 4],
      ['https://b.example', 0],
      ['https://d.example', 7]
    ])
    expect(
      buildReturnedRanks(
        [{ url: 'https://b.example' }, { url: 'https://d.example' }],
        ranks
      )
    ).toEqual([0, 7])
  })

  // Rank 0 is the BEST rank. A truthiness filter would silently drop the
  // single most important data point in the whole distribution.
  it('keeps rank 0', () => {
    expect(
      buildReturnedRanks(
        [{ url: 'https://a.example' }],
        new Map([['https://a.example', 0]])
      )
    ).toEqual([0])
  })

  // Ollama results are merged in after the gate ran, so they legitimately have
  // no pre-crawl rank. Emitting a placeholder would corrupt the p95.
  it('omits urls that were never ranked', () => {
    expect(
      buildReturnedRanks(
        [{ url: 'https://a.example' }, { url: 'https://unranked.example' }],
        new Map([['https://a.example', 2]])
      )
    ).toEqual([2])
  })

  it('returns empty when nothing was ranked', () => {
    expect(
      buildReturnedRanks([{ url: 'https://a.example' }], new Map())
    ).toEqual([])
  })

  it('returns empty for no results', () => {
    expect(buildReturnedRanks([], new Map([['https://a.example', 1]]))).toEqual(
      []
    )
  })
})
