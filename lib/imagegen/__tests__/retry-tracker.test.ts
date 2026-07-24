import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRetryForTests,
  __setRetryClientForTests,
  trackRetry
} from '../retry-tracker'

beforeEach(() => {
  __resetRetryForTests()
  __setRetryClientForTests(null) // in-memory path
})

describe('trackRetry', () => {
  it('escalates on the 4th consecutive retry, then resets', async () => {
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 2,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 3,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({ attempt: 4, escalate: true })
    // counter reset after escalation — the cycle starts over
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('a non-retry generation resets the streak', async () => {
    await trackRetry('c1', true)
    await trackRetry('c1', true)
    expect(await trackRetry('c1', false)).toEqual({
      attempt: 0,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('tracks chats independently', async () => {
    await trackRetry('c1', true)
    expect(await trackRetry('c2', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('uses the client when available and sets a TTL on the first increment', async () => {
    const incr = vi.fn().mockResolvedValue(1)
    const del = vi.fn().mockResolvedValue(1)
    const expire = vi.fn().mockResolvedValue(1)
    __setRetryClientForTests({ incr, del, expire })
    await trackRetry('c9', true)
    expect(incr).toHaveBeenCalledWith('imagegen:retry:c9')
    expect(expire).toHaveBeenCalledWith('imagegen:retry:c9', 60 * 60 * 24)
  })

  it('falls back to memory when the client throws', async () => {
    __setRetryClientForTests({
      incr: vi.fn().mockRejectedValue(new Error('down')),
      del: vi.fn().mockRejectedValue(new Error('down')),
      expire: vi.fn().mockRejectedValue(new Error('down'))
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('abandons the failing client after a fallback and keeps counting in memory', async () => {
    const incr = vi.fn().mockRejectedValue(new Error('down'))
    const del = vi.fn().mockRejectedValue(new Error('down'))
    const expire = vi.fn().mockRejectedValue(new Error('down'))
    __setRetryClientForTests({ incr, del, expire })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
    // the failing client is abandoned after the first blip: no further INCRs,
    // and memory keeps advancing without a disjoint reset (attempt 1 then 2)
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 2,
      escalate: false
    })
    expect(incr).toHaveBeenCalledTimes(1)
  })
})
