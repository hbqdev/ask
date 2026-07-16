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

const keywordRow = (chatId: string, chatTitle: string) => ({
  chatId,
  chatTitle,
  snippet: 'literal match',
  role: 'user',
  lastViewedAt: null
})

describe('searchUserChatsHybrid', () => {
  beforeEach(() => vi.resetAllMocks())

  it('unions both arms — keyword results first, semantic appended', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit])
    const keywordSearch = vi.fn(async () => [keywordRow('c9', 'Old')])

    const res = await searchUserChatsHybrid('u1', 'backups', 20, keywordSearch)

    expect(res).toHaveLength(2)
    expect(res[0].chatId).toBe('c9') // keyword first, unreordered
    expect(res[1].chatId).toBe('c1') // semantic appended
  })

  it('dedups by chatId across the union, keeping the keyword row', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit]) // chatId c1
    const keywordSearch = vi.fn(async () => [keywordRow('c1', 'Keyword Title')])

    const res = await searchUserChatsHybrid('u1', 'backups', 20, keywordSearch)

    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c1')
    expect(res[0].chatTitle).toBe('Keyword Title') // keyword row wins, not semantic
  })

  it('returns keyword results when semantic is empty', async () => {
    vi.mocked(recallSearch).mockResolvedValue([])
    const keywordSearch = vi.fn(async () => [keywordRow('c9', 'Old')])

    const res = await searchUserChatsHybrid('u1', 'zzz', 20, keywordSearch)

    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c9')
  })

  it('returns semantic results when keyword is empty', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit])
    const keywordSearch = vi.fn(async () => [])

    const res = await searchUserChatsHybrid('u1', 'backups', 20, keywordSearch)

    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c1')
  })

  it('returns [] when both arms are empty — "No results" must be honest', async () => {
    vi.mocked(recallSearch).mockResolvedValue([])
    const keywordSearch = vi.fn(async () => [])

    const res = await searchUserChatsHybrid('u1', 'zzzzz', 20, keywordSearch)

    expect(res).toEqual([])
  })

  it('keeps keyword results when recallSearch throws — the box never breaks', async () => {
    vi.mocked(recallSearch).mockRejectedValue(new Error('down'))
    const keywordSearch = vi.fn(async () => [keywordRow('c9', 'Old')])

    const res = await searchUserChatsHybrid('u1', 'q', 20, keywordSearch)

    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c9')
  })

  it('respects limit, slicing the merged union', async () => {
    vi.mocked(recallSearch).mockResolvedValue([
      { ...hit, chunkId: 'k1', chatId: 's1' },
      { ...hit, chunkId: 'k2', chatId: 's2' }
    ])
    const keywordSearch = vi.fn(async () => [
      keywordRow('c1', 'One'),
      keywordRow('c2', 'Two')
    ])

    const res = await searchUserChatsHybrid('u1', 'backups', 3, keywordSearch)

    expect(res).toHaveLength(3)
    expect(res.map(r => r.chatId)).toEqual(['c1', 'c2', 's1'])
  })
})
