import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FOLLOWUP_RATE_LIMIT,
  FOLLOWUP_RATE_WINDOW_MS,
  resetFollowupRateLimit,
  takeFollowupSlot,
  trackedFollowupUsers
} from '../rate-limit'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-14T00:00:00Z'))
  resetFollowupRateLimit()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('takeFollowupSlot', () => {
  it('allows 20 requests per 60 s per user, then refuses', () => {
    expect(FOLLOWUP_RATE_LIMIT).toBe(20)
    expect(FOLLOWUP_RATE_WINDOW_MS).toBe(60_000)
    for (let i = 0; i < 20; i++) expect(takeFollowupSlot('u1')).toBe(true)
    expect(takeFollowupSlot('u1')).toBe(false)
  })

  it('counts each user separately', () => {
    for (let i = 0; i < 20; i++) takeFollowupSlot('u1')
    expect(takeFollowupSlot('u1')).toBe(false)
    expect(takeFollowupSlot('u2')).toBe(true)
  })

  it('a refused request does not use up a slot', () => {
    for (let i = 0; i < 20; i++) takeFollowupSlot('u1')
    // Hammering while limited must not push the window further out.
    for (let i = 0; i < 50; i++) takeFollowupSlot('u1')
    vi.advanceTimersByTime(60_000)
    expect(takeFollowupSlot('u1')).toBe(true)
  })

  it('is a rolling window: a slot frees exactly 60 s after it was taken', () => {
    takeFollowupSlot('u1') // t=0
    vi.advanceTimersByTime(30_000)
    for (let i = 0; i < 19; i++) takeFollowupSlot('u1') // t=30s
    expect(takeFollowupSlot('u1')).toBe(false)

    vi.advanceTimersByTime(29_999) // t=59.999s: the t=0 slot is still held
    expect(takeFollowupSlot('u1')).toBe(false)
    vi.advanceTimersByTime(1) // t=60s: it frees, the t=30s ones don't
    expect(takeFollowupSlot('u1')).toBe(true)
    expect(takeFollowupSlot('u1')).toBe(false)

    vi.advanceTimersByTime(30_000) // t=90s: the 19 from t=30s free
    for (let i = 0; i < 19; i++) expect(takeFollowupSlot('u1')).toBe(true)
    expect(takeFollowupSlot('u1')).toBe(false)
  })

  it('prunes users whose requests are all older than the window', () => {
    takeFollowupSlot('u1')
    takeFollowupSlot('u2')
    expect(trackedFollowupUsers()).toBe(2)
    vi.advanceTimersByTime(60_000)
    takeFollowupSlot('u3')
    expect(trackedFollowupUsers()).toBe(1)
  })
})
