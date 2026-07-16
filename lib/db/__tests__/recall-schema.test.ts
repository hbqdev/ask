import { describe, expect, it } from 'vitest'

import { conversationChunks, userSettings } from '../schema'

describe('conversationChunks schema', () => {
  it('has the columns the recall feature needs', () => {
    const cols = Object.keys(conversationChunks)
    for (const c of [
      'id',
      'userId',
      'chatId',
      'messageId',
      'role',
      'content',
      'chunkIndex',
      'embedding',
      'createdAt'
    ]) {
      expect(cols).toContain(c)
    }
  })
})

describe('userSettings schema', () => {
  it('has a per-user recall toggle alongside the memory toggle', () => {
    const cols = Object.keys(userSettings)
    expect(cols).toContain('memoryEnabled')
    expect(cols).toContain('recallEnabled')
  })
})
