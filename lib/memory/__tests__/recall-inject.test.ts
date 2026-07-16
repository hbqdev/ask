import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../recall-search', () => ({ recallSearch: vi.fn() }))

import { buildRecallBlock, getRecallInjection } from '../recall-inject'
import { recallSearch } from '../recall-search'

const hit = (over: Partial<any> = {}) => ({
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: 'Use the 3-2-1 rule.',
  createdAt: new Date('2026-07-01'),
  score: 0.9,
  ...over
})

describe('buildRecallBlock', () => {
  it('formats hits with their chat title and date', () => {
    const block = buildRecallBlock([hit()])
    expect(block).toContain('Relevant past conversations')
    expect(block).toContain('Backups')
    expect(block).toContain('2026-07-01')
    expect(block).toContain('Use the 3-2-1 rule.')
  })

  it('returns empty string for no hits', () => {
    expect(buildRecallBlock([])).toBe('')
  })
})

describe('getRecallInjection', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns an empty block without a userId and never searches', async () => {
    expect(await getRecallInjection(undefined, 'q', 'c1')).toEqual({
      block: '',
      hits: []
    })
    expect(recallSearch).not.toHaveBeenCalled()
  })

  it('excludes the current chat and reranks (rerank-scale minScore gate)', async () => {
    vi.mocked(recallSearch).mockResolvedValue([hit()])
    const res = await getRecallInjection('u1', 'q', 'c9')
    expect(res.hits).toHaveLength(1)
    expect(recallSearch).toHaveBeenCalledWith(
      'u1',
      'q',
      expect.objectContaining({
        useRerank: true,
        excludeChatId: 'c9',
        minScore: 0.05
      })
    )
  })

  it('never throws — an error yields an empty block', async () => {
    vi.mocked(recallSearch).mockRejectedValue(new Error('boom'))
    await expect(getRecallInjection('u1', 'q', 'c1')).resolves.toEqual({
      block: '',
      hits: []
    })
  })
})
