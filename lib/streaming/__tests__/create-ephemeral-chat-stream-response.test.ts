import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createEphemeralChatStreamResponse } from '@/lib/streaming/create-ephemeral-chat-stream-response'

const captured = vi.hoisted(() => ({
  classifierMessages: undefined as any,
  modelMessages: undefined as any
}))

vi.mock('@/lib/agents/query-classifier', () => ({
  classifyQuery: vi.fn(async ({ messages }: { messages: unknown }) => {
    captured.classifierMessages = messages
    return {
      skipSearch: true,
      standaloneQuery: 'q',
      needsRecent: false,
      needsSources: false,
      intent: 'general'
    }
  })
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

describe('createEphemeralChatStreamResponse', () => {
  beforeEach(() => {
    captured.classifierMessages = undefined
    captured.modelMessages = undefined
  })

  it('returns 400 when messages are missing', async () => {
    const response = await createEphemeralChatStreamResponse({
      messages: [],
      model: { providerId: 'openai', id: 'gpt-4o-mini' } as any,
      abortSignal: new AbortController().signal,
      searchMode: 'speed'
    })

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toBe('messages are required')
  })

  it('feeds the classifier and the model the narration-free history (D20)', async () => {
    const vi_chatter = 'Tôi cần đọc trang fandom này để lấy cấu trúc chi tiết.'
    const vi_preamble = 'Tôi đã có đủ thông tin. Bây giờ viết câu trả lời.'
    const answer =
      '## Thôn Phệ Tinh Không\n\nCự Phủ Sáng Thế Giả là cột trụ duy nhất của nhân tộc, và cái chết của ông mở màn đại chiến chủng tộc.'
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await createEphemeralChatStreamResponse({
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Cự Phủ?' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            { type: 'text', text: vi_chatter },
            {
              type: 'tool-fetch',
              toolCallId: 'f1',
              state: 'output-available',
              input: { url: 'https://example.com' },
              output: { results: [] }
            },
            { type: 'text', text: vi_preamble + answer }
          ]
        },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'Tiếp đi.' }] }
      ] as any,
      model: { providerId: 'openai', id: 'gpt-4o-mini' } as any,
      abortSignal: new AbortController().signal,
      searchMode: 'balanced'
    })
    await response.text()

    const classifierText = JSON.stringify(captured.classifierMessages)
    expect(classifierText).toContain('Thôn Phệ Tinh Không')
    expect(classifierText).not.toContain(vi_chatter)
    expect(classifierText).not.toContain('Bây giờ viết câu trả lời')

    const modelText = JSON.stringify(captured.modelMessages)
    expect(modelText).toContain('Cự Phủ Sáng Thế Giả là cột trụ')
    expect(modelText).not.toContain(vi_chatter)
    expect(modelText).not.toContain('Bây giờ viết câu trả lời')
  })
})
