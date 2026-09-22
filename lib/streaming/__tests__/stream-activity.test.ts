import { describe, expect, test, vi } from 'vitest'

import {
  isAnyStreamActive,
  setStreamActive,
  subscribeStreamActivity
} from '../stream-activity'

describe('stream-activity', () => {
  test('stays active until every reporting instance has settled', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeStreamActivity(listener)

    setStreamActive('chat-1', true)
    setStreamActive('chat-2', true)
    expect(isAnyStreamActive()).toBe(true)

    setStreamActive('chat-1', false)
    expect(isAnyStreamActive()).toBe(true)

    setStreamActive('chat-2', false)
    expect(isAnyStreamActive()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(4)

    // Repeating the current state is not a change.
    setStreamActive('chat-2', false)
    expect(listener).toHaveBeenCalledTimes(4)

    unsubscribe()
    setStreamActive('chat-1', true)
    expect(listener).toHaveBeenCalledTimes(4)
    setStreamActive('chat-1', false)
  })
})
