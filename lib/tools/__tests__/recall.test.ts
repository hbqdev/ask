import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/memory/recall-search', () => ({ recallSearch: vi.fn() }))
vi.mock('@/lib/db/recall-actions', () => ({ isRecallEnabled: vi.fn() }))

import { isRecallEnabled } from '@/lib/db/recall-actions'
import { recallSearch } from '@/lib/memory/recall-search'

import { createRecallTool } from '../recall'

const hit = {
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: '3-2-1 rule',
  createdAt: new Date('2026-07-01'),
  score: 0.9
}

describe('createRecallTool', () => {
  beforeEach(() => vi.resetAllMocks())

  it('is inert without a userId and never searches', async () => {
    const tool = createRecallTool(undefined, 'c1')
    expect(await tool.execute!({ query: 'x' }, {} as any)).toEqual({
      results: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('is inert when recall is disabled (kill switch gates the TOOL too)', async () => {
    vi.mocked(isRecallEnabled).mockResolvedValue(false)
    const tool = createRecallTool('u1', 'c1')
    expect(await tool.execute!({ query: 'x' }, {} as any)).toEqual({
      results: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('returns hits and excludes the current chat', async () => {
    vi.mocked(isRecallEnabled).mockResolvedValue(true)
    vi.mocked(recallSearch).mockResolvedValue([hit])
    const tool = createRecallTool('u1', 'c1')
    const res = (await tool.execute!({ query: 'backups' }, {} as any)) as any
    expect(res.results).toHaveLength(1)
    expect(res.results[0].chatTitle).toBe('Backups')
    expect(recallSearch).toHaveBeenCalledWith(
      'u1',
      'backups',
      expect.objectContaining({ useRerank: true, excludeChatId: 'c1' })
    )
  })
})
