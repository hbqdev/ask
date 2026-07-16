import { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { stripRecallFromMessage } from '../strip-recall-from-message'

describe('stripRecallFromMessage', () => {
  it('removes a data-recall part while leaving text/other parts intact', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Here is your answer.' },
        {
          type: 'data-recall',
          id: 'recall',
          data: { chats: [{ chatId: 'private-chat-a', title: 'Severance' }] }
        },
        { type: 'step-start' }
      ]
    } as unknown as UIMessage

    const result = stripRecallFromMessage(msg)

    expect(result.parts.map(p => p.type)).toEqual(['text', 'step-start'])
    expect(result.parts.some(p => p.type === 'data-recall')).toBe(false)
  })

  it('does not mutate the original message object', () => {
    const original = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Hi' },
        { type: 'data-recall', id: 'recall', data: { chats: [] } }
      ]
    } as unknown as UIMessage
    const snapshotParts = original.parts

    const result = stripRecallFromMessage(original)

    // Original object/array untouched — a new object/array was returned.
    expect(original.parts).toBe(snapshotParts)
    expect(original.parts).toHaveLength(2)
    expect(result).not.toBe(original)
    expect(result.parts).not.toBe(original.parts)
  })

  it('returns the exact same object (no defensive copy) when there is nothing to strip', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'No recall this turn.' }]
    } as unknown as UIMessage

    const result = stripRecallFromMessage(msg)

    expect(result).toBe(msg)
  })

  it('returns the message unchanged when it has no parts', () => {
    const msg = { id: 'm1', role: 'user' } as unknown as UIMessage

    const result = stripRecallFromMessage(msg)

    expect(result).toBe(msg)
  })
})
