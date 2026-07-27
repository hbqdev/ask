import { afterEach, describe, expect, it } from 'vitest'

import { resolveEffectiveDepth } from '../search'
import { routeEmitsSearchTelemetry } from '../search/basic-telemetry'

describe('resolveEffectiveDepth', () => {
  const base = {
    searchAPI: 'searxng' as const,
    modelRequestedDepth: 'basic' as const,
    envDefaultAdvanced: false,
    firstSearchDepth: 'advanced' as const,
    tieringEnabled: true
  }

  afterEach(() => {
    delete process.env.SEARXNG_DEFAULT_DEPTH
  })

  it('first searxng search of a deep-mode turn runs advanced', () => {
    expect(resolveEffectiveDepth({ ...base, firstSearchDone: false })).toBe(
      'advanced'
    )
  })

  it('subsequent searxng searches are tiered down to basic', () => {
    expect(resolveEffectiveDepth({ ...base, firstSearchDone: true })).toBe(
      'basic'
    )
  })

  it('speed mode (firstSearchDepth basic) stays basic on every search', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        firstSearchDepth: 'basic',
        firstSearchDone: false
      })
    ).toBe('basic')
  })

  it('with tiering off, falls back to env/model-driven depth (advanced)', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        tieringEnabled: false,
        envDefaultAdvanced: true,
        firstSearchDone: true
      })
    ).toBe('advanced')
  })

  it('with tiering off and no env default, uses the model-requested depth', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        tieringEnabled: false,
        modelRequestedDepth: 'advanced',
        firstSearchDone: true
      })
    ).toBe('advanced')
  })

  it('non-searxng providers are unaffected by tiering', () => {
    expect(
      resolveEffectiveDepth({
        ...base,
        searchAPI: 'tavily',
        modelRequestedDepth: 'advanced',
        firstSearchDone: true
      })
    ).toBe('advanced')
  })
})

// The advanced slot is consumed only by a search that actually RAN the
// advanced pipeline. routeEmitsSearchTelemetry is the predicate that decides
// this, so these cases pin the interaction between the two.
//
// Regression: `firstSearchDone = true` used to be set unconditionally. A first
// search with type:'general' routes to the Brave provider and never reaches
// /api/advanced-search, but it still burned the slot — so every later search
// tiered to basic and the turn got no crawl, no snippet gate and no rerank.
describe('advanced-slot consumption', () => {
  const base = {
    modelRequestedDepth: 'basic' as const,
    envDefaultAdvanced: false,
    firstSearchDepth: 'advanced' as const,
    tieringEnabled: true
  }

  it('a general (brave) search does not claim the slot, so the NEXT search still goes advanced', () => {
    // Search #1: type 'general' -> searchAPI 'brave'. Tiering is bypassed for
    // non-searxng providers, so it resolves to the model's depth...
    const first = resolveEffectiveDepth({
      ...base,
      searchAPI: 'brave',
      firstSearchDone: false
    })
    expect(first).toBe('basic')
    // ...and because it is not (searxng + advanced), it does not consume.
    expect(routeEmitsSearchTelemetry('brave', first)).toBe(false)

    // Search #2 therefore still finds the slot unclaimed.
    expect(
      resolveEffectiveDepth({
        ...base,
        searchAPI: 'searxng',
        firstSearchDone: false
      })
    ).toBe('advanced')
  })

  it('an advanced searxng search DOES claim the slot', () => {
    const depth = resolveEffectiveDepth({
      ...base,
      searchAPI: 'searxng',
      firstSearchDone: false
    })
    expect(depth).toBe('advanced')
    expect(routeEmitsSearchTelemetry('searxng', depth)).toBe(true)
    // Once claimed, the next search tiers down — still one advanced per turn.
    expect(
      resolveEffectiveDepth({
        ...base,
        searchAPI: 'searxng',
        firstSearchDone: true
      })
    ).toBe('basic')
  })

  it('speed mode never claims the slot, and never needs to', () => {
    // firstSearchDepth is 'basic', so resolveEffectiveDepth returns 'basic'
    // whether or not the slot is claimed — the change is a no-op here.
    for (const done of [false, true]) {
      const depth = resolveEffectiveDepth({
        ...base,
        searchAPI: 'searxng',
        firstSearchDepth: 'basic',
        firstSearchDone: done
      })
      expect(depth).toBe('basic')
      expect(routeEmitsSearchTelemetry('searxng', depth)).toBe(false)
    }
  })
})
