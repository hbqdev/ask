import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/memory/recall-search', () => ({ recallSearch: vi.fn() }))

import { recallSearch } from '@/lib/memory/recall-search'

import { searchUserChatsHybrid } from '../actions'

const hit = {
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: 'Use the 3-2-1 rule for backups.',
  createdAt: new Date('2026-07-01'),
  score: 0.9
}

describe('searchUserChatsHybrid', () => {
  beforeEach(() => vi.resetAllMocks())

  it('maps recall hits onto the ChatSearchResult shape, deduped per chat', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit, { ...hit, chunkId: 'k2' }])
    const res = await searchUserChatsHybrid('u1', 'backups', 20, async () => [])
    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c1')
    expect(res[0].chatTitle).toBe('Backups')
    expect(res[0].snippet).toContain('3-2-1')
  })

  it('falls back to the keyword path when recall returns nothing', async () => {
    vi.mocked(recallSearch).mockResolvedValue([])
    const fallback = vi.fn(async () => [
      {
        chatId: 'c9',
        chatTitle: 'Old',
        snippet: 'literal match',
        role: 'user',
        lastViewedAt: null
      }
    ])
    const res = await searchUserChatsHybrid('u1', 'zzz', 20, fallback as any)
    expect(fallback).toHaveBeenCalled()
    expect(res[0].chatId).toBe('c9')
  })

  it('falls back when recall throws — the search box must never break', async () => {
    vi.mocked(recallSearch).mockRejectedValue(new Error('down'))
    const fallback = vi.fn(async () => [])
    await expect(
      searchUserChatsHybrid('u1', 'q', 20, fallback as any)
    ).resolves.toEqual([])
    expect(fallback).toHaveBeenCalled()
  })
})
