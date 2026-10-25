import { describe, expect, it, vi } from 'vitest'

// The authenticated route's history pipeline, driven far enough to capture the
// messages the researcher is handed. Pins that a prior search's display-only
// expandedQueries never reaches the model, while the rest of its output does.

const captured = vi.hoisted(() => ({
  history: [] as unknown[],
  modelMessages: undefined as unknown
}))

vi.mock('@/lib/streaming/helpers/prepare-messages', () => ({
  prepareMessages: vi.fn(async () => captured.history)
}))
vi.mock('@/lib/agents/researcher', () => ({
  researcher: vi.fn(async () => ({
    stream: vi.fn(async ({ messages }: { messages: unknown }) => {
      captured.modelMessages = messages
      // Stop here: this test only inspects what the model would be sent.
      throw new Error('stop after capture')
    })
  }))
}))
vi.mock('@/lib/utils/resolve-context-window', () => ({
  resolveContextWindow: vi.fn(async () => undefined)
}))
vi.mock('@/lib/streaming/resumable-stream-context', () => ({
  getResumableStreamContext: vi.fn(async () => null),
  setActiveStreamId: vi.fn(),
  clearActiveStreamId: vi.fn()
}))
vi.mock('@/lib/streaming/helpers/persist-stream-results', () => ({
  persistStreamResults: vi.fn(async () => {})
}))
vi.mock('@/lib/agents/title-generator', () => ({
  generateChatTitle: vi.fn(async () => 'title')
}))

import { createChatStreamResponse } from '@/lib/streaming/create-chat-stream-response'

describe('createChatStreamResponse: replayed history', () => {
  it("never replays a prior search's expandedQueries to the model", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const output = {
      state: 'complete',
      query: 'rtx 5090 price',
      images: [],
      results: [{ title: 'A', url: 'https://a.test/', content: 'alpha' }],
      number_of_results: 1
    }
    captured.history = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'price?' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search',
            toolCallId: 's1',
            state: 'output-available',
            input: { query: 'rtx 5090 price' },
            output: { ...output, expandedQueries: ['variant zebra'] }
          },
          { type: 'text', text: 'About $1999.' }
        ]
      },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '5080?' }] }
    ]

    const response = await createChatStreamResponse({
      message: null,
      model: { providerId: 'openai', id: 'gpt-4o-mini' } as any,
      chatId: 'chat-history-strip',
      userId: '',
      isNewChat: true,
      searchMode: 'speed',
      abortSignal: new AbortController().signal
    })
    await response.text()

    expect(captured.modelMessages).toBeDefined()
    const modelText = JSON.stringify(captured.modelMessages)
    expect(modelText).not.toContain('expandedQueries')
    expect(modelText).not.toContain('variant zebra')
    expect(modelText).toContain(JSON.stringify(output))
  })
})
