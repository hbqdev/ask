import { afterEach, describe, expect, it } from 'vitest'

import {
  buildDisabledEnginesParam,
  filterHealthyEngines,
  isEngineSuspended,
  parseUnresponsiveEngines,
  recordFailure,
  recordSuccess
} from '../engine-health'

// SearXNG reports which engines failed but keeps calling them. Measured on the
// live instance: unresponsive_engines was [['brave','too many requests'],
// ['startpage','CAPTCHA']] while both were still being queried on every search.
// Each attempt is pure latency AND burns IP reputation against a provider that
// is already blocking us — which is how the blocking started.
//
// SearXNG has no runtime API to disable an engine, so the gate lives on the
// client: Ask already picks which engines to request, so it can stop asking for
// the dead ones.

const OPTS = { threshold: 3, windowMs: 600_000, cooldownMs: 1_800_000 }
const T0 = 1_000_000

describe('parseUnresponsiveEngines', () => {
  it('reads the [name, reason] pair shape SearXNG actually returns', () => {
    expect(
      parseUnresponsiveEngines([
        ['brave', 'too many requests'],
        ['startpage', 'CAPTCHA']
      ])
    ).toEqual(['brave', 'startpage'])
  })

  it('reads a bare list of names', () => {
    expect(parseUnresponsiveEngines(['brave'])).toEqual(['brave'])
  })

  it('returns [] for a missing or malformed field rather than throwing', () => {
    // A parser that throws here would take down search itself.
    expect(parseUnresponsiveEngines(undefined)).toEqual([])
    expect(parseUnresponsiveEngines(null)).toEqual([])
    expect(parseUnresponsiveEngines('brave')).toEqual([])
    expect(parseUnresponsiveEngines([[], [123]])).toEqual([])
  })
})

describe('recordFailure / isEngineSuspended', () => {
  it('does not suspend on the first breach — one CAPTCHA is noise', () => {
    const s = recordFailure(undefined, T0, OPTS)
    expect(isEngineSuspended(s, T0)).toBe(false)
  })

  it('suspends once the threshold is reached inside the window', () => {
    let s = recordFailure(undefined, T0, OPTS)
    s = recordFailure(s, T0 + 1_000, OPTS)
    expect(isEngineSuspended(s, T0 + 1_000)).toBe(false)
    s = recordFailure(s, T0 + 2_000, OPTS)
    expect(isEngineSuspended(s, T0 + 2_000)).toBe(true)
  })

  it('does not suspend when breaches are spread beyond the window', () => {
    // Three failures across an hour is an engine having a bad day, not a block.
    let s = recordFailure(undefined, T0, OPTS)
    s = recordFailure(s, T0 + OPTS.windowMs + 1, OPTS)
    s = recordFailure(s, T0 + 2 * OPTS.windowMs + 2, OPTS)
    expect(isEngineSuspended(s, T0 + 2 * OPTS.windowMs + 2)).toBe(false)
  })

  it('lifts the suspension once the cooldown expires', () => {
    let s = recordFailure(undefined, T0, OPTS)
    s = recordFailure(s, T0, OPTS)
    s = recordFailure(s, T0, OPTS)
    expect(isEngineSuspended(s, T0 + OPTS.cooldownMs - 1)).toBe(true)
    expect(isEngineSuspended(s, T0 + OPTS.cooldownMs + 1)).toBe(false)
  })

  it('re-suspends on a single failure after a failed retry', () => {
    // The retry after cooldown IS the probe. If it fails, go straight back to
    // suspended rather than paying two more round trips to re-learn it.
    let s = recordFailure(undefined, T0, OPTS)
    s = recordFailure(s, T0, OPTS)
    s = recordFailure(s, T0, OPTS)
    const afterCooldown = T0 + OPTS.cooldownMs + 1
    s = recordFailure(s, afterCooldown, OPTS)
    expect(isEngineSuspended(s, afterCooldown)).toBe(true)
  })

  it('clears the count on success so a recovered engine is fully restored', () => {
    let s = recordFailure(undefined, T0, OPTS)
    s = recordFailure(s, T0, OPTS)
    s = recordSuccess()
    s = recordFailure(s, T0, OPTS)
    expect(isEngineSuspended(s, T0)).toBe(false)
  })

  it('treats a missing record as healthy', () => {
    expect(isEngineSuspended(undefined, T0)).toBe(false)
  })
})

describe('filterHealthyEngines', () => {
  const requested = ['bing', 'duckduckgo', 'wikipedia', 'google cse']

  it('drops a suspended engine from the requested list', () => {
    expect(filterHealthyEngines(requested, new Set(['google cse']))).toEqual([
      'bing',
      'duckduckgo',
      'wikipedia'
    ])
  })

  it('preserves order — engine order is part of the pinned config', () => {
    expect(filterHealthyEngines(requested, new Set(['duckduckgo']))).toEqual([
      'bing',
      'wikipedia',
      'google cse'
    ])
  })

  it('NEVER strands the last engine — returns the original list untouched', () => {
    // The guard that matters. A search against a blocked engine may still
    // return something; a search with an empty engine list returns nothing,
    // guaranteed. Degrading to "try anyway" beats degrading to "no results".
    expect(filterHealthyEngines(requested, new Set(requested))).toEqual(
      requested
    )
  })

  it('returns the original list when nothing is suspended', () => {
    expect(filterHealthyEngines(requested, new Set())).toEqual(requested)
  })

  it('ignores suspensions for engines this search did not request', () => {
    expect(filterHealthyEngines(['bing'], new Set(['brave']))).toEqual(['bing'])
  })

  it('handles an empty requested list without inventing engines', () => {
    expect(filterHealthyEngines([], new Set(['brave']))).toEqual([])
  })
})

// Dropping an engine from `engines` does NOT stop SearXNG calling it.
// Measured on the live instance: SearXNG UNIONS `categories` with `engines`,
// so with categories=general every enabled general engine runs regardless of
// the pin. brave/startpage/mojeek were all being queried by Ask despite never
// appearing in SEARXNG_ENGINES_ADVANCED.
//
// Verified against staging with one query, holding q constant:
//   engines=bing,duckduckgo,wikipedia,google cse
//     + disabled_engines=brave__general,startpage__general,google cse__general
//     -> unresponsive: duckduckgo, google cse, mojeek   (brave/startpage gone,
//        but google cse survived — naming it in `engines` overrides the disable)
//   engines=bing,duckduckgo,wikipedia
//     + disabled_engines=...,google cse__general,mojeek__general
//     -> unresponsive: duckduckgo only
// So suspension needs BOTH halves.
describe('buildDisabledEnginesParam', () => {
  it('emits name__category for every requested category', () => {
    expect(
      buildDisabledEnginesParam(new Set(['brave']), ['general', 'images'])
    ).toBe('brave__general,brave__images')
  })

  it('covers every suspended engine', () => {
    const out = buildDisabledEnginesParam(new Set(['brave', 'startpage']), [
      'general'
    ])
    expect(out.split(',').sort()).toEqual([
      'brave__general',
      'startpage__general'
    ])
  })

  it('preserves engine names containing spaces', () => {
    // 'google cse' is the engine's real name; the space must survive so
    // SearXNG matches it. URLSearchParams handles the encoding.
    expect(
      buildDisabledEnginesParam(new Set(['google cse']), ['general'])
    ).toBe('google cse__general')
  })

  it('is empty when nothing is suspended', () => {
    expect(buildDisabledEnginesParam(new Set(), ['general'])).toBe('')
  })

  it('is empty when no categories are in play', () => {
    // The academic/social branches pin no engines and take no categories list
    // from us; emitting a bare name__ would disable nothing and risk a parse
    // error on SearXNG's side.
    expect(buildDisabledEnginesParam(new Set(['brave']), [])).toBe('')
  })
})

// The gate changes which engines run, so it needs a real off switch — and the
// switch has to fail OPEN. If the health store is unavailable the correct
// behaviour is today's behaviour (ask everything), not an empty engine list.
describe('ENGINE_HEALTH_ENABLED', () => {
  afterEach(() => {
    delete process.env.ENGINE_HEALTH_ENABLED
  })

  it('is opt-out: only the exact string false disables it', async () => {
    const { engineHealthEnabled } = await import('../engine-health')
    delete process.env.ENGINE_HEALTH_ENABLED
    expect(engineHealthEnabled()).toBe(true)
    process.env.ENGINE_HEALTH_ENABLED = 'no'
    expect(engineHealthEnabled()).toBe(true)
    process.env.ENGINE_HEALTH_ENABLED = 'false'
    expect(engineHealthEnabled()).toBe(false)
  })
})
