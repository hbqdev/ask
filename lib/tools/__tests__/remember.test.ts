import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/memory/write', () => ({
  saveCandidates: vi.fn()
}))
vi.mock('@/lib/db/memory-actions', () => ({
  isMemoryEnabled: vi.fn()
}))

import * as memoryActions from '@/lib/db/memory-actions'
import * as memoryWrite from '@/lib/memory/write'

import { createRememberTool } from '../remember'

describe('createRememberTool', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is inert with no userId — does not call saveCandidates', async () => {
    const tool = createRememberTool(undefined)
    const result = await tool.execute!(
      { content: 'Self-hosts everything', category: 'fact' },
      {} as any
    )

    expect(result).toEqual({ saved: false })
    expect(memoryWrite.saveCandidates).not.toHaveBeenCalled()
  })

  it('is inert when memory is disabled (kill switch off) — does not call saveCandidates', async () => {
    vi.mocked(memoryActions.isMemoryEnabled).mockResolvedValue(false)
    const tool = createRememberTool('u1')
    const result = await tool.execute!(
      { content: 'Self-hosts everything', category: 'fact' },
      {} as any
    )

    expect(result).toEqual({ saved: false })
    expect(memoryActions.isMemoryEnabled).toHaveBeenCalledWith('u1')
    expect(memoryWrite.saveCandidates).not.toHaveBeenCalled()
  })

  it('saves a confirmed memory when memory is enabled', async () => {
    vi.mocked(memoryActions.isMemoryEnabled).mockResolvedValue(true)
    vi.mocked(memoryWrite.saveCandidates).mockResolvedValue(1)
    const tool = createRememberTool('u1')
    const result = await tool.execute!(
      { content: 'Prefers concise answers', category: 'preference' },
      {} as any
    )

    expect(result).toEqual({ saved: true })
    expect(memoryWrite.saveCandidates).toHaveBeenCalledWith('u1', [
      {
        content: 'Prefers concise answers',
        category: 'preference',
        confirmed: true
      }
    ])
  })
})
