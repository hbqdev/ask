import { describe, expect, it, vi } from 'vitest'

import { withDeadline } from '../with-deadline'

describe('withDeadline', () => {
  it('returns the real value when the work finishes in time', async () => {
    const result = await withDeadline(
      Promise.resolve('crawled'),
      1000,
      () => 'snippet'
    )
    expect(result).toBe('crawled')
  })

  it('falls back when the work overruns the deadline', async () => {
    vi.useFakeTimers()
    const slow = new Promise<string>(resolve =>
      setTimeout(() => resolve('crawled'), 10_000)
    )

    const pending = withDeadline(slow, 1_000, () => 'snippet')
    await vi.advanceTimersByTimeAsync(1_001)

    await expect(pending).resolves.toBe('snippet')
    vi.useRealTimers()
  })

  it('falls back when the work rejects, rather than propagating', async () => {
    const result = await withDeadline(
      Promise.reject(new Error('connection reset')),
      1000,
      () => 'snippet'
    )
    expect(result).toBe('snippet')
  })

  it('does not leave a pending timer once the work settles', async () => {
    vi.useFakeTimers()
    const pending = withDeadline(Promise.resolve('crawled'), 5_000, () => 'x')
    await expect(pending).resolves.toBe('crawled')
    // A leaked timer would keep the process alive for the full deadline.
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
