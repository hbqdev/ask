import { ModelMessage } from 'ai'
import { describe, expect, test } from 'vitest'

import { Model } from '@/lib/types/models'

import {
  getMaxAllowedTokens,
  shouldTruncateMessages,
  truncateMessages
} from '../context-window'

describe('context-window', () => {
  const mockModel: Model = {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    provider: 'OpenAI',
    providerId: 'openai'
  }

  const createMessage = (
    role: 'user' | 'assistant',
    content: string
  ): ModelMessage => ({
    role,
    content
  })

  describe('getMaxAllowedTokens', () => {
    test('calculates max tokens correctly for known model', () => {
      const maxTokens = getMaxAllowedTokens(mockModel)
      // Expected: (128000 - 16384) - (128000 * 0.1) = 111616 - 12800 = 98816
      expect(maxTokens).toBe(98816)
    })

    // Was: unknown models fell back to a 16384 window, i.e. 10650 tokens of
    // history. Every Ollama model we run misses the static map, so that
    // default was silently discarding conversation history on a model whose
    // real window is 262144. An unknown window must mean "do not truncate".
    test('returns null (no limit) for a model whose window we do not know', () => {
      const unknownModel: Model = { ...mockModel, id: 'unknown-model' }
      expect(getMaxAllowedTokens(unknownModel)).toBeNull()
    })

    test('uses a caller-supplied window, so a probed value wins over the map', () => {
      const kimi: Model = { ...mockModel, id: 'kimi-k2.6:cloud' }
      // 262144 - 8192 reserve - floor(262144 * 0.1) = 253952 - 26214 = 227738
      expect(getMaxAllowedTokens(kimi, 262144)).toBe(227738)
    })

    test('ensures minimum viable token count', () => {
      // This would need a model with very small context window to test
      // For now, verify the function returns at least 1000
      const maxTokens = getMaxAllowedTokens(mockModel)
      expect(maxTokens).toBeGreaterThanOrEqual(1000)
    })

    test('uses the real ~1M window for production Gemini models', () => {
      // (1048576 - 65536) - floor(1048576 * 0.1) = 983040 - 104857 = 878183
      for (const id of ['gemini-3-flash-preview', 'gemini-3.1-flash-lite']) {
        const maxTokens = getMaxAllowedTokens({ ...mockModel, id })
        expect(maxTokens).toBe(878183)
      }
    })
  })

  describe('shouldTruncateMessages', () => {
    test('returns false for empty messages', () => {
      expect(shouldTruncateMessages([], mockModel)).toBe(false)
    })

    test('returns false when under limit', () => {
      const messages: ModelMessage[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there!')
      ]
      expect(shouldTruncateMessages(messages, mockModel)).toBe(false)
    })

    test('returns true when over limit', () => {
      // Create messages that exceed the token limit
      // mockModel (gpt-4o-mini) has 98816 max tokens
      const longText = 'This is a test message. '.repeat(1000) // ~6000 tokens per message
      const messages: ModelMessage[] = Array(20)
        .fill(null)
        .map(() => createMessage('user', longText)) // Total: ~120,000 tokens > 98,816 max tokens
      expect(shouldTruncateMessages(messages, mockModel)).toBe(true)
    })

    test('handles null/undefined messages gracefully', () => {
      expect(shouldTruncateMessages(null as any, mockModel)).toBe(false)
      expect(shouldTruncateMessages(undefined as any, mockModel)).toBe(false)
    })

    test('never truncates a model whose window is unknown, however long the chat', () => {
      const unknownModel: Model = { ...mockModel, id: 'unknown-model' }
      const longText = 'This is a test message. '.repeat(1000)
      const messages: ModelMessage[] = Array(40)
        .fill(null)
        .map(() => createMessage('user', longText))
      expect(shouldTruncateMessages(messages, unknownModel)).toBe(false)
    })

    test('truncates against a probed window when one is supplied', () => {
      const kimi: Model = { ...mockModel, id: 'kimi-k2.6:cloud' }
      const longText = 'This is a test message. '.repeat(1000) // ~6k tokens
      const messages: ModelMessage[] = Array(60)
        .fill(null)
        .map(() => createMessage('user', longText)) // ~360k tokens
      expect(shouldTruncateMessages(messages, kimi, 262144)).toBe(true)
      // ...but the same chat is fine for a model that really is that big.
      expect(shouldTruncateMessages(messages, kimi, 2_000_000)).toBe(false)
    })
  })

  describe('truncateMessages', () => {
    test('returns empty array for empty messages', () => {
      expect(truncateMessages([], 1000)).toEqual([])
    })

    test('returns empty array for invalid maxTokens', () => {
      const messages = [createMessage('user', 'Hello')]
      expect(truncateMessages(messages, 0)).toEqual([])
      expect(truncateMessages(messages, -100)).toEqual([])
    })

    test('returns all messages when under limit', () => {
      const messages: ModelMessage[] = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi!'),
        createMessage('user', 'How are you?'),
        createMessage('assistant', 'I am fine!')
      ]
      const result = truncateMessages(messages, 10000)
      expect(result).toEqual(messages)
    })

    test('preserves first user message when possible', () => {
      const messages: ModelMessage[] = [
        createMessage('user', 'First important context'),
        createMessage('assistant', 'Response 1'),
        createMessage('user', 'Question 2'),
        createMessage('assistant', 'Response 2'),
        createMessage('user', 'Question 3'),
        createMessage('assistant', 'Response 3')
      ]

      const result = truncateMessages(messages, 100) // Very low limit
      expect(result.length).toBeGreaterThan(0)
      expect(result[0]).toEqual(messages[0]) // First user message preserved
    })

    test('removes assistant messages to keep user messages', () => {
      const messages: ModelMessage[] = [
        createMessage('user', 'Question 1'),
        createMessage('assistant', 'Very long response '.repeat(50)),
        createMessage('user', 'Question 2'),
        createMessage('assistant', 'Another long response '.repeat(50)),
        createMessage('user', 'Important last question')
      ]

      const result = truncateMessages(messages, 200)
      const userMessages = result.filter(m => m.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
      expect(userMessages[userMessages.length - 1].content).toBe(
        'Important last question'
      )
    })

    test('removes leading assistant messages when truncating', () => {
      // Create messages that will force truncation
      const longText = 'a'.repeat(1000) // ~250 tokens each
      const messages: ModelMessage[] = [
        createMessage('assistant', longText),
        createMessage('assistant', longText),
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi'),
        createMessage('user', 'Last message')
      ]

      // Force truncation with low limit
      const result = truncateMessages(messages, 100)

      // After truncation, should prefer user messages
      expect(result.length).toBeGreaterThan(0)

      // The implementation removes leading non-user messages after truncation
      const hasUserMessage = result.some(m => m.role === 'user')
      expect(hasUserMessage).toBe(true)
    })

    test('handles messages with complex content types', () => {
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' }
          ]
        },
        {
          role: 'assistant',
          content: 'Response'
        }
      ]

      const result = truncateMessages(messages, 1000)
      expect(result.length).toBeGreaterThan(0)
    })

    test('handles undefined content gracefully', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Response' }
      ]

      const result = truncateMessages(messages, 1000)
      expect(result).toBeDefined()
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('truncation with model ID', () => {
    test('uses tiktoken when model ID is provided', () => {
      const messages: ModelMessage[] = [
        createMessage('user', 'Test message for token counting')
      ]

      // With model ID - should use tiktoken
      const resultWithModel = truncateMessages(messages, 1000, 'gpt-4o-mini')
      expect(resultWithModel).toBeDefined()

      // Without model ID - should use fallback
      const resultWithoutModel = truncateMessages(messages, 1000)
      expect(resultWithoutModel).toBeDefined()
    })
  })

  describe('truncateMessages boundary cases', () => {
    const big = (n: number) => 'word '.repeat(n)

    test('never returns an empty prompt when one message exceeds the window', () => {
      // Previously returned [] and the turn called stream({ messages: [] }).
      // Reachable because transform-file-parts inlines whole pdftotext output
      // into the user message with no size cap.
      const messages = [{ role: 'user' as const, content: big(20000) }]

      const result = truncateMessages(messages, 100, 'test-model')

      expect(result.length).toBeGreaterThan(0)
      expect(result[result.length - 1].role).toBe('user')
    })

    test('keeps the question being asked, not the first one', () => {
      // Previously returned exactly [user('hello')] — the model answered the
      // FIRST question and never saw the one just asked.
      const messages = [
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'hi' },
        { role: 'user' as const, content: big(20000) }
      ]

      const result = truncateMessages(messages, 100, 'test-model')

      const last = result[result.length - 1]
      expect(last.role).toBe('user')
      expect(last.content).toBe(messages[2].content)
    })

    test('still returns everything when it already fits', () => {
      const messages = [
        { role: 'user' as const, content: 'short question' },
        { role: 'assistant' as const, content: 'short answer' }
      ]

      expect(truncateMessages(messages, 100000, 'test-model')).toEqual(messages)
    })
  })
})
