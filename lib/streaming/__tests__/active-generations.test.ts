import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  registerGeneration,
  settleStoppedTurn,
  stopGeneration,
  unregisterGeneration,
  waitForStoppedTurn,
  wasStoppedByUser
} from '../active-generations'

describe('active-generations', () => {
  afterEach(() => {
    vi.useRealTimers()
    settleStoppedTurn('chat-1')
  })

  it('marks an explicit Stop as a user stop', () => {
    const c = registerGeneration('chat-1')
    expect(stopGeneration('chat-1')).toBe(true)
    expect(wasStoppedByUser(c)).toBe(true)
  })

  it('does not treat a superseded turn as a user stop', () => {
    const old = registerGeneration('chat-1')
    const next = registerGeneration('chat-1')
    expect(old.signal.aborted).toBe(true)
    expect(wasStoppedByUser(old)).toBe(false)
    expect(wasStoppedByUser(next)).toBe(false)
    unregisterGeneration('chat-1', next)
  })

  it('does not treat a timeout-aborted signal as a user stop', () => {
    expect(wasStoppedByUser(null)).toBe(false)
    const c = new AbortController()
    c.abort(new DOMException('timeout', 'TimeoutError'))
    expect(wasStoppedByUser(c)).toBe(false)
  })

  it('holds a follow-up until the stopped turn settles', async () => {
    registerGeneration('chat-1')
    stopGeneration('chat-1')
    let released = false
    const waiting = waitForStoppedTurn('chat-1', 10_000).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    settleStoppedTurn('chat-1')
    await waiting
    expect(released).toBe(true)
  })

  it('never waits past the bound', async () => {
    vi.useFakeTimers()
    registerGeneration('chat-1')
    stopGeneration('chat-1')
    const waiting = waitForStoppedTurn('chat-1', 50)
    await vi.advanceTimersByTimeAsync(60)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('resolves immediately when nothing is pending', async () => {
    await expect(waitForStoppedTurn('idle-chat')).resolves.toBeUndefined()
  })
})

describe('abort reasons', () => {
  it('are AbortError DOMExceptions so the AI SDK treats them as aborts', () => {
    const stopped = registerGeneration('chat-2')
    stopGeneration('chat-2')
    settleStoppedTurn('chat-2')
    expect((stopped.signal.reason as DOMException).name).toBe('AbortError')

    const old = registerGeneration('chat-3')
    const next = registerGeneration('chat-3')
    expect((old.signal.reason as DOMException).name).toBe('AbortError')
    unregisterGeneration('chat-3', next)
  })
})
