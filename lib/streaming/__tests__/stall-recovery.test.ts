import { describe, expect, it, vi } from 'vitest'

import {
  isVisibleTextPart,
  type StallRecoveryEvent,
  withStallRecovery} from '../helpers/stall-recovery'

type Part = { type: string }

/** Collect a stream to an array, surfacing the error if it errors. */
async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value as T)
  }
}

/**
 * A stream that emits `parts` with `gapMs` between each, then either closes or
 * — when `stallAfter` is reached — goes silent forever. Silence is the whole
 * subject of these tests, so it is modelled literally rather than as an error.
 */
function scriptedStream(opts: {
  parts: Part[]
  gapMs?: number
  stallAfter?: number
  signal?: AbortSignal
}): ReadableStream<Part> {
  const { parts, gapMs = 0, stallAfter, signal } = opts
  let i = 0
  return new ReadableStream<Part>({
    async pull(controller) {
      if (stallAfter !== undefined && i >= stallAfter) {
        // Never resolves on its own; only the abort below ends it.
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            {
              once: true
            }
          )
        })
        return
      }
      if (i >= parts.length) return controller.close()
      if (gapMs) await new Promise(r => setTimeout(r, gapMs))
      controller.enqueue(parts[i++])
    }
  })
}

describe('withStallRecovery', () => {
  it('passes a healthy stream through untouched', async () => {
    const parts = [
      { type: 'reasoning-start' },
      { type: 'text-start' },
      { type: 'text-delta' },
      { type: 'text-end' }
    ]
    const out = await drain(
      withStallRecovery<Part>({
        attempt: async () => scriptedStream({ parts }),
        isCommitted: isVisibleTextPart,
        stallMs: 10_000
      })
    )
    expect(out).toEqual(parts)
  })

  it('retries once when the stream stalls before any prose', async () => {
    // Reproduces the measured failure: reasoning starts, one delta, silence.
    const attempts: number[] = []
    const events: StallRecoveryEvent[] = []
    const stream = withStallRecovery<Part>({
      attempt: async signal => {
        const n = attempts.push(1)
        return n === 1
          ? scriptedStream({
              parts: [{ type: 'reasoning-start' }, { type: 'reasoning-delta' }],
              stallAfter: 2,
              signal
            })
          : scriptedStream({
              parts: [{ type: 'text-start' }, { type: 'text-delta' }]
            })
      },
      isCommitted: isVisibleTextPart,
      stallMs: 40,
      onEvent: e => events.push(e)
    })

    const out = await drain(stream)
    expect(attempts).toHaveLength(2)
    // The dead attempt's reasoning was already sent and is kept; the answer
    // comes from the retry.
    expect(out.map(p => p.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'text-start',
      'text-delta'
    ])
    expect(events.map(e => e.type)).toEqual(['stall', 'retry'])
  })

  it('does NOT retry once prose has been committed, and keeps the partial', async () => {
    // Restarting here would duplicate or contradict text the user is already
    // reading, so the guard degrades to "stop waiting".
    const attempts: number[] = []
    const events: StallRecoveryEvent[] = []
    const out = await drain(
      withStallRecovery<Part>({
        attempt: async signal => {
          attempts.push(1)
          return scriptedStream({
            parts: [{ type: 'text-start' }, { type: 'text-delta' }],
            stallAfter: 2,
            signal
          })
        },
        isCommitted: isVisibleTextPart,
        stallMs: 40,
        onEvent: e => events.push(e)
      })
    )

    expect(attempts).toHaveLength(1)
    expect(out.map(p => p.type)).toEqual(['text-start', 'text-delta'])
    expect(events.filter(e => e.type === 'stall')).toHaveLength(1)
    expect(events.some(e => e.type === 'retry')).toBe(false)
  })

  it('errors rather than looping when every attempt stalls', async () => {
    const attempts: number[] = []
    const events: StallRecoveryEvent[] = []
    const stream = withStallRecovery<Part>({
      attempt: async signal => {
        attempts.push(1)
        return scriptedStream({ parts: [], stallAfter: 0, signal })
      },
      isCommitted: isVisibleTextPart,
      stallMs: 30,
      onEvent: e => events.push(e)
    })

    await expect(drain(stream)).rejects.toThrow()
    expect(attempts).toHaveLength(2)
    expect(events.some(e => e.type === 'exhausted')).toBe(true)
  })

  it('resets the clock on every part, so a slow-but-alive stream survives', async () => {
    // The bug this guards against: arming once at stream start would abort any
    // generation longer than stallMs, however healthily it was streaming.
    const events: StallRecoveryEvent[] = []
    const out = await drain(
      withStallRecovery<Part>({
        attempt: async () =>
          scriptedStream({
            parts: Array.from({ length: 8 }, () => ({
              type: 'reasoning-delta'
            })),
            gapMs: 20
          }),
        isCommitted: isVisibleTextPart,
        stallMs: 60,
        onEvent: e => events.push(e)
      })
    )
    expect(out).toHaveLength(8)
    expect(events).toEqual([])
  })

  it('aborts the in-flight attempt when the consumer cancels', async () => {
    const aborted = vi.fn()
    const stream = withStallRecovery<Part>({
      attempt: async signal => {
        signal.addEventListener('abort', aborted, { once: true })
        return scriptedStream({
          parts: [{ type: 'reasoning-start' }],
          stallAfter: 1,
          signal
        })
      },
      isCommitted: isVisibleTextPart,
      stallMs: 10_000
    })

    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => expect(aborted).toHaveBeenCalled())
  })
})

describe('isVisibleTextPart', () => {
  it('treats text parts as commitment and reasoning as not', () => {
    expect(isVisibleTextPart({ type: 'text-start' })).toBe(true)
    expect(isVisibleTextPart({ type: 'text-delta' })).toBe(true)
    // Reasoning renders in a collapsible panel; a duplicate block there is
    // cosmetic, and treating it as commitment would forfeit the recovery.
    expect(isVisibleTextPart({ type: 'reasoning-delta' })).toBe(false)
    expect(isVisibleTextPart({ type: 'tool-input-available' })).toBe(false)
    expect(isVisibleTextPart(null)).toBe(false)
    expect(isVisibleTextPart({})).toBe(false)
  })
})
