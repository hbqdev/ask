import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/recall-actions', () => ({
  messagesWithoutChunks: vi.fn(),
  isRecallEnabled: vi.fn(async () => true)
}))
vi.mock('../recall-index', () => ({ indexMessage: vi.fn(async () => 3) }))

import * as db from '@/lib/db/recall-actions'

import { backfillUser } from '../recall-backfill'
import { indexMessage } from '../recall-index'

const msg = (id: string) => ({
  messageId: id,
  chatId: 'c1',
  role: 'user' as const,
  text: 'hello'
})

describe('backfillUser', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Default: recall enabled, so existing tests don't all need to stub it.
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
  })

  it('drains batches until none remain and totals the counts', async () => {
    vi.mocked(db.messagesWithoutChunks)
      .mockResolvedValueOnce([msg('m1'), msg('m2')])
      .mockResolvedValueOnce([])
    const res = await backfillUser('u1')
    expect(res).toEqual({ messages: 2, chunks: 6, ok: true })
    expect(indexMessage).toHaveBeenCalledTimes(2)
  })

  it('stops at maxBatches so it can never spin forever', async () => {
    vi.mocked(db.messagesWithoutChunks).mockResolvedValue([msg('m1')])
    const res = await backfillUser('u1', { batchSize: 1, maxBatches: 3 })
    expect(res.messages).toBe(3)
    expect(res.ok).toBe(true)
  })

  it('never throws — a DB error returns what it managed, flagged not-ok', async () => {
    vi.mocked(db.messagesWithoutChunks).mockRejectedValue(new Error('db down'))
    await expect(backfillUser('u1')).resolves.toEqual({
      messages: 0,
      chunks: 0,
      ok: false
    })
  })

  it('short-circuits without calling messagesWithoutChunks when recall is disabled', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    const res = await backfillUser('u1')
    expect(res).toEqual({ messages: 0, chunks: 0, ok: false })
    expect(db.messagesWithoutChunks).not.toHaveBeenCalled()
    expect(indexMessage).not.toHaveBeenCalled()
  })
})
