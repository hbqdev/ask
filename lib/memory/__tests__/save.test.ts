import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async (t: string[]) => t.map(() => [0.1, 0.2])),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/memory-actions', () => ({
  nearestMemory: vi.fn(),
  insertMemory: vi.fn(),
  bumpMemory: vi.fn(),
  supersedeMemory: vi.fn(),
  evictOverCap: vi.fn()
}))

import * as db from '@/lib/db/memory-actions'

import { saveCandidates } from '../write'

describe('saveCandidates', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts a new candidate when nothing similar', async () => {
    vi.mocked(db.nearestMemory).mockResolvedValue(null)
    const n = await saveCandidates('u1', [
      { content: 'Self-hosts', category: 'fact' }
    ])
    expect(db.insertMemory).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ status: 'candidate', content: 'Self-hosts' })
    )
    expect(n).toBe(1)
  })

  it('bumps + graduates a near-duplicate candidate at the threshold', async () => {
    vi.mocked(db.nearestMemory).mockResolvedValue({
      id: 'm1',
      content: 'Self-hosts everything',
      status: 'candidate',
      sightings: 1,
      similarity: 0.97
    })
    await saveCandidates('u1', [{ content: 'Self-hosts', category: 'fact' }])
    expect(db.bumpMemory).toHaveBeenCalledWith('u1', 'm1', true)
    expect(db.insertMemory).not.toHaveBeenCalled()
  })

  it('never throws — a DB error is swallowed and counted as 0', async () => {
    vi.mocked(db.nearestMemory).mockRejectedValue(new Error('db down'))
    await expect(
      saveCandidates('u1', [{ content: 'x', category: 'fact' }])
    ).resolves.toBe(0)
  })
})
