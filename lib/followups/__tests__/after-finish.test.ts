import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

const fetchFollowups = vi.fn()
vi.mock('../fetch-followups', () => ({
  fetchFollowups: (...args: unknown[]) => fetchFollowups(...args)
}))
const captureClient = vi.fn()
vi.mock('@/lib/analytics/posthog-client', () => ({
  captureClient: (...args: unknown[]) => captureClient(...args)
}))

import { loadFollowupsAfterFinish } from '../after-finish'

const u = {
  id: 'u',
  role: 'user',
  parts: [{ type: 'text', text: 'q' }]
} as UIMessage
const a = {
  id: 'a',
  role: 'assistant',
  parts: [{ type: 'text', text: '## Answer' }]
} as UIMessage
const other = {
  id: 'b',
  role: 'assistant',
  parts: [{ type: 'text', text: '## Other' }]
} as UIMessage

function run(
  overrides: Partial<Parameters<typeof loadFollowupsAfterFinish>[0]> = {}
) {
  const setMessages = vi.fn()
  const promise = loadFollowupsAfterFinish({
    message: a,
    messages: [u, a],
    chatId: 'chat-1',
    isCurrentChat: true,
    isAbort: false,
    isError: false,
    isGuest: false,
    setMessages,
    ...overrides
  })
  return { setMessages, promise }
}

beforeEach(() => {
  fetchFollowups.mockReset()
  captureClient.mockReset()
})

describe('loadFollowupsAfterFinish', () => {
  it('fetches, stores the questions on the message and captures', async () => {
    fetchFollowups.mockResolvedValue(['x?', 'y?'])
    const { setMessages, promise } = run()
    await promise
    expect(fetchFollowups).toHaveBeenCalledWith({
      question: 'q',
      answer: '## Answer',
      previousQuestions: [],
      chatId: 'chat-1',
      messageId: 'a'
    })
    expect(setMessages).toHaveBeenCalledTimes(1)
    const updater = setMessages.mock.calls[0][0]
    const next = updater([u, { ...a, metadata: { traceId: 't' } }, other])
    expect(next[1].metadata).toEqual({ traceId: 't', followups: ['x?', 'y?'] })
    expect(next[0]).toBe(u)
    expect(next[2]).toBe(other)
    expect(captureClient).toHaveBeenCalledWith('followups_shown', {
      chatId: 'chat-1',
      count: 2
    })
  })

  it('does not store or capture when no questions come back', async () => {
    fetchFollowups.mockResolvedValue([])
    const { setMessages, promise } = run()
    await promise
    expect(fetchFollowups).toHaveBeenCalledTimes(1)
    expect(setMessages).not.toHaveBeenCalled()
    expect(captureClient).not.toHaveBeenCalled()
  })

  it.each([
    ['abort', { isAbort: true }],
    ['error', { isError: true }],
    ['another chat', { isCurrentChat: false }],
    ['a guest', { isGuest: true }]
  ])('sends no request on %s', async (_label, overrides) => {
    const { setMessages, promise } = run(overrides)
    await promise
    expect(fetchFollowups).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
  })

  it('sends no request for a clarifying question', async () => {
    const ask = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'tool-askQuestion', toolCallId: 't', state: 'input-available' }
      ]
    } as unknown as UIMessage
    const { promise } = run({ message: ask, messages: [u, ask] })
    await promise
    expect(fetchFollowups).not.toHaveBeenCalled()
  })
})
