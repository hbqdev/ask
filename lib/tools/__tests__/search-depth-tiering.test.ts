import { afterEach, describe, expect, it } from 'vitest'

import { resolveEffectiveDepth } from '../search'

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
