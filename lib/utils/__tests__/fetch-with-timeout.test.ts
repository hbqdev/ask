import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createTimeoutFetch } from '../fetch-with-timeout'

// These cover cleanup, not behaviour: a leaked timer or listener changes no
// result, so nothing else in the suite would ever notice. getModel builds ONE
// timeout-fetch per turn and reuses it for every step, so a listener that is
// never removed accumulates per HTTP call on the request's AbortSignal — up to
// 50 on a balanced turn, 100 on quality, past Node's warning threshold of 10.
describe('createTimeoutFetch cleanup', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  test('clears the timer when fetch itself rejects', async () => {
    // Previously the timer was only cleared in flush() or the no-body return,
    // so a connection refusal left a 300s timer armed holding the closure and
    // the AbortController.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')

    const timeoutFetch = createTimeoutFetch(300_000)

    await expect(timeoutFetch('http://example.test')).rejects.toThrow(
      'ECONNREFUSED'
    )
    expect(clearSpy).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('removes its abort listener when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'))
    const external = new AbortController()
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener')

    const timeoutFetch = createTimeoutFetch(300_000, external.signal)

    await expect(timeoutFetch('http://example.test')).rejects.toThrow('boom')
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  test('does not accumulate listeners across reused calls', async () => {
    // The real shape: one timeout-fetch, many sequential requests.
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('x'))
    const external = new AbortController()
    const addSpy = vi.spyOn(external.signal, 'addEventListener')
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener')

    const timeoutFetch = createTimeoutFetch(300_000, external.signal)
    for (let i = 0; i < 5; i++) {
      await expect(timeoutFetch('http://example.test')).rejects.toThrow('x')
    }

    // Every listener added is also removed — net zero, rather than 5 retained.
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('clears the timer when the caller aborts', async () => {
    // A cancelled or errored body never reaches flush(), which is the common
    // case when a client disconnects mid-stream.
    // Reject when the controller signal aborts, the way a real fetch does.
    globalThis.fetch = vi.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        })
    ) as unknown as typeof fetch
    const external = new AbortController()

    const timeoutFetch = createTimeoutFetch(300_000, external.signal)
    const pending = timeoutFetch('http://example.test').catch(() => undefined)

    external.abort(new Error('client gone'))
    await pending

    expect(vi.getTimerCount()).toBe(0)
  })
})
