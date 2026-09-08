import { afterEach, describe, expect, it } from 'vitest'

import { resolveSearchRoundsBudget } from '../search'

// The per-turn search-round cap is enforced INSIDE the search tool's execute
// (a round counter closed over per turn), which is unreachable from a unit
// test without a full tool-call context. The budget it compares against is
// pulled out as a pure function so the mode-awareness and env overrides can be
// asserted directly — the same pattern as resolveEffectiveDepth.
describe('resolveSearchRoundsBudget', () => {
  afterEach(() => {
    delete process.env.SEARCH_ROUNDS_MAX
    delete process.env.SEARCH_ROUNDS_MAX_QUALITY
  })

  it('defaults balanced / undefined mode to 3 rounds', () => {
    expect(resolveSearchRoundsBudget('balanced')).toBe(3)
    expect(resolveSearchRoundsBudget(undefined)).toBe(3)
  })

  it('defaults speed to the general 3-round budget (safety net)', () => {
    expect(resolveSearchRoundsBudget('speed')).toBe(3)
  })

  it('gives quality a higher default ceiling of 5 rounds', () => {
    expect(resolveSearchRoundsBudget('quality')).toBe(5)
  })

  it('honors SEARCH_ROUNDS_MAX for non-quality modes', () => {
    process.env.SEARCH_ROUNDS_MAX = '2'
    expect(resolveSearchRoundsBudget('balanced')).toBe(2)
    expect(resolveSearchRoundsBudget('speed')).toBe(2)
    // Quality has its OWN knob and is unaffected by the general one.
    expect(resolveSearchRoundsBudget('quality')).toBe(5)
  })

  it('honors SEARCH_ROUNDS_MAX_QUALITY only for quality mode', () => {
    process.env.SEARCH_ROUNDS_MAX_QUALITY = '8'
    expect(resolveSearchRoundsBudget('quality')).toBe(8)
    expect(resolveSearchRoundsBudget('balanced')).toBe(3)
  })

  it('ignores non-positive / non-numeric overrides and falls back to the default', () => {
    for (const bad of ['0', '-4', 'abc', '']) {
      process.env.SEARCH_ROUNDS_MAX = bad
      expect(resolveSearchRoundsBudget('balanced')).toBe(3)
    }
  })

  it('floors fractional overrides', () => {
    process.env.SEARCH_ROUNDS_MAX = '3.9'
    expect(resolveSearchRoundsBudget('balanced')).toBe(3)
  })
})
