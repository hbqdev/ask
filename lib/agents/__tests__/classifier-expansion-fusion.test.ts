import { afterEach, describe, expect, it } from 'vitest'

import { resolveExpandedQueries } from '../classifier-expansion'

// The classifier and the expander are two serial calls to the SAME model on
// the SAME host: classify 6.9-9s, then expand 6.6-12.3s. The expander can only
// start once the classifier resolves, because it needs standaloneQuery. Vane
// gets classification AND its standalone rewrite from one call; fusing removes
// a whole round trip and is worth doing whether the call ends up local or
// cloud.
//
// This helper decides what the turn's expanded queries actually are, given
// what the fused classifier returned and whether this turn wants expansion at
// all. Keeping it pure means the precedence rules are testable without a model.
describe('resolveExpandedQueries', () => {
  it('uses the classifier queries when it returned some', async () => {
    const fallback = async () => ['SHOULD NOT BE CALLED']
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['a', 'b'],
        wantsExpansion: true,
        fallback
      })
    ).resolves.toEqual(['a', 'b'])
  })

  it('does not call the separate expander when the fused call supplied queries', async () => {
    // The whole point is removing the second round trip.
    let called = 0
    const fallback = async () => {
      called++
      return ['x']
    }
    await resolveExpandedQueries({
      fromClassifier: ['a'],
      wantsExpansion: true,
      fallback
    })
    expect(called).toBe(0)
  })

  it('falls back to the separate expander when the fused call returned none', async () => {
    // Degradation path: an older model, a refusal, or a schema miss must not
    // silently cost the turn its query expansion.
    await expect(
      resolveExpandedQueries({
        fromClassifier: [],
        wantsExpansion: true,
        fallback: async () => ['recovered']
      })
    ).resolves.toEqual(['recovered'])
  })

  it('returns [] and calls nothing when the turn does not want expansion', async () => {
    let called = 0
    const out = await resolveExpandedQueries({
      fromClassifier: ['a', 'b'],
      wantsExpansion: false,
      fallback: async () => {
        called++
        return ['x']
      }
    })
    expect(out).toEqual([])
    expect(called).toBe(0)
  })

  it('drops blank and duplicate queries rather than searching them', async () => {
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['a', '  ', 'a', 'b', ''],
        wantsExpansion: true,
        fallback: async () => []
      })
    ).resolves.toEqual(['a', 'b'])
  })

  it('caps at three, matching the expander contract', async () => {
    const out = await resolveExpandedQueries({
      fromClassifier: ['a', 'b', 'c', 'd', 'e'],
      wantsExpansion: true,
      fallback: async () => []
    })
    expect(out).toHaveLength(3)
  })

  it('survives a throwing fallback — expansion is optional, the turn is not', async () => {
    await expect(
      resolveExpandedQueries({
        fromClassifier: [],
        wantsExpansion: true,
        fallback: async () => {
          throw new Error('expander down')
        }
      })
    ).resolves.toEqual([])
  })

  it('treats an all-blank classifier list as none and recovers via fallback', async () => {
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['   ', ''],
        wantsExpansion: true,
        fallback: async () => ['recovered']
      })
    ).resolves.toEqual(['recovered'])
  })
})

// Fusing expansion into the classifier silently killed the off switch: the
// QUERY_EXPANSION_ENABLED gate lives in expandQuery, which fusion demoted to a
// fallback that only runs when the classifier returns nothing. Setting the flag
// disabled the fallback and left the real expansion untouched.
//
// That matters operationally — expansion is 3x the engine load on every turn's
// first search, and with SearXNG engines returning CAPTCHAs an emergency lever
// to drop it is worth having.
describe('QUERY_EXPANSION_ENABLED governs the fused path too', () => {
  afterEach(() => {
    delete process.env.QUERY_EXPANSION_ENABLED
  })

  it('returns [] and ignores classifier queries when expansion is disabled', async () => {
    process.env.QUERY_EXPANSION_ENABLED = 'false'
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['a', 'b', 'c'],
        wantsExpansion: true,
        fallback: async () => ['should not be reached']
      })
    ).resolves.toEqual([])
  })

  it('does not call the fallback expander when disabled', async () => {
    process.env.QUERY_EXPANSION_ENABLED = 'false'
    let called = 0
    await resolveExpandedQueries({
      fromClassifier: [],
      wantsExpansion: true,
      fallback: async () => {
        called++
        return ['x']
      }
    })
    expect(called).toBe(0)
  })

  it('expands normally when the flag is unset', async () => {
    delete process.env.QUERY_EXPANSION_ENABLED
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['a'],
        wantsExpansion: true,
        fallback: async () => []
      })
    ).resolves.toEqual(['a'])
  })

  it('treats any value other than the exact string false as enabled', async () => {
    process.env.QUERY_EXPANSION_ENABLED = 'no'
    await expect(
      resolveExpandedQueries({
        fromClassifier: ['a'],
        wantsExpansion: true,
        fallback: async () => []
      })
    ).resolves.toEqual(['a'])
  })
})
