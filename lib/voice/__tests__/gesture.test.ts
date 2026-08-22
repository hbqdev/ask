import { describe, expect, it } from 'vitest'

import { HOLD_THRESHOLD_MS, shouldStopOnRelease } from '../gesture'

describe('shouldStopOnRelease', () => {
  it('a short press below the threshold is a tap: keep recording', () => {
    expect(shouldStopOnRelease(0)).toBe(false)
    expect(shouldStopOnRelease(100)).toBe(false)
    expect(shouldStopOnRelease(HOLD_THRESHOLD_MS - 1)).toBe(false)
  })

  it('a press at or above the threshold is a hold: stop on release', () => {
    expect(shouldStopOnRelease(HOLD_THRESHOLD_MS + 1)).toBe(true)
    expect(shouldStopOnRelease(1000)).toBe(true)
  })

  it('the boundary (=250ms) counts as a hold', () => {
    expect(HOLD_THRESHOLD_MS).toBe(250)
    expect(shouldStopOnRelease(HOLD_THRESHOLD_MS)).toBe(true)
  })
})
