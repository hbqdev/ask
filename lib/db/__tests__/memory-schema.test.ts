import { describe, expect, it } from 'vitest'

import { userMemories, userSettings } from '../schema'

describe('memory schema', () => {
  it('userMemories has the memory columns', () => {
    const cols = Object.keys(userMemories)
    for (const c of [
      'id',
      'userId',
      'content',
      'category',
      'status',
      'sightings',
      'embedding',
      'sourceChatId',
      'lastUsedAt'
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('userSettings has memoryEnabled', () => {
    expect(Object.keys(userSettings)).toContain('memoryEnabled')
  })
})
