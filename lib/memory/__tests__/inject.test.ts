import { describe, expect, it } from 'vitest'

import { buildMemoryBlock } from '../inject'

describe('buildMemoryBlock', () => {
  it('formats confirmed memories as a bulleted block', () => {
    const block = buildMemoryBlock([
      { content: 'Self-hosts their infrastructure' },
      { content: 'Prefers concise answers' }
    ])
    expect(block).toContain('What you know about this user')
    expect(block).toContain('- Self-hosts their infrastructure')
    expect(block).toContain('- Prefers concise answers')
  })

  it('returns empty string for no memories', () => {
    expect(buildMemoryBlock([])).toBe('')
  })
})
