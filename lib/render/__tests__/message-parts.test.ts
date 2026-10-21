import type { UIMessage } from 'ai'
import { describe, expect, test } from 'vitest'

import {
  isAnswerText,
  isGeneratedImagePart,
  isResearchPart,
  isTurnStreaming
} from '../message-parts'

type Part = UIMessage['parts'][number]
const part = (p: Record<string, unknown>) => p as unknown as Part

describe('isTurnStreaming', () => {
  test('latest message while streaming', () => {
    expect(isTurnStreaming(true, 'streaming')).toBe(true)
  })
  test('latest message while submitted', () => {
    expect(isTurnStreaming(true, 'submitted')).toBe(true)
  })
  test('latest message when ready', () => {
    expect(isTurnStreaming(true, 'ready')).toBe(false)
  })
  test('an earlier message never streams, whatever the chat status', () => {
    expect(isTurnStreaming(false, 'streaming')).toBe(false)
  })
})

describe('isAnswerText', () => {
  const complete = { streamingComplete: true, isLastNonEmptyTextPart: true }
  const streaming = { streamingComplete: false, isLastNonEmptyTextPart: true }

  test('empty text is never the answer', () => {
    expect(isAnswerText('', complete)).toBe(false)
    expect(isAnswerText('', streaming)).toBe(false)
  })
  test('whitespace-only text is never the answer', () => {
    expect(isAnswerText('   \n', complete)).toBe(false)
  })
  test('complete: the last non-empty text part is the answer', () => {
    expect(isAnswerText('Plain answer', complete)).toBe(true)
  })
  test('complete: an earlier text part is narration', () => {
    expect(
      isAnswerText('## Heading', {
        streamingComplete: true,
        isLastNonEmptyTextPart: false
      })
    ).toBe(false)
  })
  test('streaming: a markdown heading is the answer', () => {
    expect(isAnswerText('## Answer', streaming)).toBe(true)
  })
  test('streaming: leading whitespace before the heading is ignored', () => {
    expect(isAnswerText('  # x', streaming)).toBe(true)
  })
  test('streaming: text without a heading is narration', () => {
    expect(isAnswerText('Let me search', streaming)).toBe(false)
  })
  test('streaming: a hash with no following space is not a heading', () => {
    expect(isAnswerText('#nospace', streaming)).toBe(false)
  })
})

describe('isGeneratedImagePart', () => {
  test('live tool-generateImage part', () => {
    expect(isGeneratedImagePart(part({ type: 'tool-generateImage' }))).toBe(
      true
    )
  })
  test('reloaded dynamic-tool generateImage part', () => {
    expect(
      isGeneratedImagePart(
        part({ type: 'dynamic-tool', toolName: 'generateImage' })
      )
    ).toBe(true)
  })
  test('another dynamic tool', () => {
    expect(
      isGeneratedImagePart(
        part({ type: 'dynamic-tool', toolName: 'calculate' })
      )
    ).toBe(false)
  })
})

describe('isResearchPart', () => {
  test.each([
    ['reasoning', { type: 'reasoning', text: 'thinking' }],
    [
      'data-classifier',
      { type: 'data-classifier', data: { state: 'running' } }
    ],
    [
      'data-attachments',
      { type: 'data-attachments', data: { state: 'done', count: 1 } }
    ],
    ['tool-search', { type: 'tool-search' }],
    ['tool-fetch', { type: 'tool-fetch' }],
    ['dynamic-tool calculate', { type: 'dynamic-tool', toolName: 'calculate' }],
    [
      'data-recall with chats',
      { type: 'data-recall', data: { chats: [{ chatId: 'a', title: 't' }] } }
    ]
  ])('%s is research', (_label, p) => {
    expect(isResearchPart(part(p))).toBe(true)
  })

  test.each([
    ['data-recall with no chats', { type: 'data-recall', data: { chats: [] } }],
    ['tool-generateImage', { type: 'tool-generateImage' }],
    [
      'dynamic-tool generateImage',
      { type: 'dynamic-tool', toolName: 'generateImage' }
    ],
    ['text', { type: 'text', text: '## Answer' }],
    ['data-title', { type: 'data-title', data: { title: 'T' } }],
    ['step-start', { type: 'step-start' }]
  ])('%s is not research', (_label, p) => {
    expect(isResearchPart(part(p))).toBe(false)
  })
})
