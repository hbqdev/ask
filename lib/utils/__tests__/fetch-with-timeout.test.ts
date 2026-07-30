import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTimeoutFetch } from '../fetch-with-timeout'

// A fetch stand-in that never resolves on its own — it settles only when the
// signal it was handed aborts. That models the thing under test: an ollama
// request that has stopped producing but is still holding its socket open.
function hangingFetch() {
  const seen: AbortSignal[] = []
  const impl = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
    const signal = init?.signal as AbortSignal
    seen.push(signal)
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true
      })
    })
  })
  return { impl, seen }
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('createTimeoutFetch — externalSignal', () => {
  it('aborts the request when a signal passed BY VALUE fires', async () => {
    const { impl } = hangingFetch()
    globalThis.fetch = impl as unknown as typeof fetch

    const ac = new AbortController()
    const f = createTimeoutFetch(60_000, ac.signal)
    const inFlight = f('https://example.test', {})
    ac.abort()

    await expect(inFlight).rejects.toThrow()
  })

  // THE REGRESSION. The model object is built once per turn, so a signal
  // passed by value is captured once and shared by every later request —
  // including the one stall recovery issues after abandoning a dead
  // generation. Measured consequence: the guard's abort never reached the
  // socket, so the stalled request ran on to the 300s ceiling *beside* its own
  // retry, two live generations for one turn.
  it('resolves a FUNCTION signal per request, so each attempt binds its own', async () => {
    const { impl } = hangingFetch()
    globalThis.fetch = impl as unknown as typeof fetch

    let current: AbortController | undefined
    const f = createTimeoutFetch(60_000, () => current?.signal)

    // Attempt 1 opens its connection under its own controller.
    const first = new AbortController()
    current = first
    const attempt1 = f('https://example.test', {})

    // The guard gives up and retries; attempt 2 gets a fresh controller.
    const second = new AbortController()
    current = second
    const attempt2 = f('https://example.test', {})

    // Aborting attempt 1 must kill attempt 1 — this is what did NOT happen.
    first.abort()
    await expect(attempt1).rejects.toThrow()

    // ...and must leave the retry running.
    let settled = false
    void attempt2.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    // The retry is still cancellable by its own signal.
    second.abort()
    await expect(attempt2).rejects.toThrow()
  })

  it('re-reads the getter on every call rather than caching the first value', async () => {
    const { impl } = hangingFetch()
    globalThis.fetch = impl as unknown as typeof fetch

    const getter = vi.fn(() => new AbortController().signal)
    const f = createTimeoutFetch(60_000, getter)
    void f('https://example.test', {}).catch(() => {})
    void f('https://example.test', {}).catch(() => {})

    expect(getter).toHaveBeenCalledTimes(2)
  })

  it('tolerates a getter that returns undefined', async () => {
    const { impl } = hangingFetch()
    globalThis.fetch = impl as unknown as typeof fetch

    const f = createTimeoutFetch(60_000, () => undefined)
    const inFlight = f('https://example.test', {})
    // No external signal to fire; the per-request timeout still governs, and
    // the call must not throw synchronously on the undefined.
    let settled = false
    void inFlight.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it('still honours init.signal alongside the external one', async () => {
    const { impl } = hangingFetch()
    globalThis.fetch = impl as unknown as typeof fetch

    const external = new AbortController()
    const perCall = new AbortController()
    const f = createTimeoutFetch(60_000, () => external.signal)
    const inFlight = f('https://example.test', { signal: perCall.signal })

    perCall.abort()
    await expect(inFlight).rejects.toThrow()
  })
})
