import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/recall-actions', () => ({
  messagesWithoutChunks: vi.fn(),
  isRecallEnabled: vi.fn(async () => true)
}))
vi.mock('../recall-index', () => ({ indexMessage: vi.fn(async () => 3) }))
vi.mock('@/lib/db', () => ({
  db: { selectDistinct: vi.fn() }
}))

import { db as rawDb } from '@/lib/db'
import * as db from '@/lib/db/recall-actions'

import { backfillAllUsers, backfillUser } from '../recall-backfill'
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

  it('never throws — a DB error returns what it managed, flagged not-ok with reason "error"', async () => {
    vi.mocked(db.messagesWithoutChunks).mockRejectedValue(new Error('db down'))
    await expect(backfillUser('u1')).resolves.toEqual({
      messages: 0,
      chunks: 0,
      ok: false,
      reason: 'error'
    })
  })

  it('short-circuits without calling messagesWithoutChunks when recall is disabled, flagged not-ok with reason "disabled"', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    const res = await backfillUser('u1')
    expect(res).toEqual({
      messages: 0,
      chunks: 0,
      ok: false,
      reason: 'disabled'
    })
    expect(db.messagesWithoutChunks).not.toHaveBeenCalled()
    expect(indexMessage).not.toHaveBeenCalled()
  })
})

// backfillAllUsers must tell "this user has recall off" (an expected,
// non-error per-user outcome) apart from "this user's backfill hit a real
// error" — conflating the two made the aggregate `ok` near-useless as a
// cron health signal (any instance with >=1 opted-out user always reported
// ok:false, indistinguishable from an actual outage). `ok` here must reflect
// ONLY real failures; disabled-recall users are counted in `skipped`
// instead, and must never flip `ok` to false on their own.
describe('backfillAllUsers', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  const msg = (id: string) => ({
    messageId: id,
    chatId: 'c1',
    role: 'user' as const,
    text: 'hello'
  })

  it('counts a disabled user as skipped (not failed) and keeps ok true', async () => {
    vi.mocked(rawDb.selectDistinct).mockReturnValue({
      from: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }])
    } as any)
    vi.mocked(db.isRecallEnabled).mockImplementation(
      async (userId: string) => userId === 'u1'
    )
    vi.mocked(db.messagesWithoutChunks)
      .mockResolvedValueOnce([msg('m1')])
      .mockResolvedValueOnce([])

    const res = await backfillAllUsers()

    expect(res).toEqual({
      users: 2,
      messages: 1,
      chunks: 3,
      ok: true,
      skipped: 1,
      failed: 0
    })
    // u2 is disabled, so it must short-circuit before touching the DB.
    expect(db.messagesWithoutChunks).toHaveBeenCalledTimes(2)
  })

  it('counts a real per-user error as failed and flips the aggregate ok to false, independent of other users being merely skipped', async () => {
    vi.mocked(rawDb.selectDistinct).mockReturnValue({
      from: vi.fn().mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }])
    } as any)
    vi.mocked(db.isRecallEnabled).mockImplementation(
      async (userId: string) => userId === 'u2'
    )
    vi.mocked(db.messagesWithoutChunks).mockRejectedValue(new Error('db down'))

    const res = await backfillAllUsers()

    expect(res).toEqual({
      users: 2,
      messages: 0,
      chunks: 0,
      ok: false,
      skipped: 1,
      failed: 1
    })
  })

  it('is ok:true with zero skipped/failed when every user backfills cleanly', async () => {
    vi.mocked(rawDb.selectDistinct).mockReturnValue({
      from: vi.fn().mockResolvedValue([{ userId: 'u1' }])
    } as any)
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(db.messagesWithoutChunks).mockResolvedValue([])

    const res = await backfillAllUsers()

    expect(res).toEqual({
      users: 1,
      messages: 0,
      chunks: 0,
      ok: true,
      skipped: 0,
      failed: 0
    })
  })
})
