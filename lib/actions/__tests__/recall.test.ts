import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/recall-actions')
vi.mock('@/lib/memory/recall-backfill')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as db from '@/lib/db/recall-actions'
import * as backfill from '@/lib/memory/recall-backfill'

import {
  clearRecallIndexAction,
  getRecallStatus,
  rebuildRecallIndexAction,
  setRecallEnabledAction
} from '../recall'

describe('recall actions', () => {
  // vi.clearAllMocks() only wipes mock.calls/mock.results — it leaves a
  // sibling test's mockResolvedValue() in place (proven buggy in Task 4).
  // vi.resetAllMocks() restores every mock to its vi.mock() factory default
  // before each test, so tests can't leak stubbed implementations.
  beforeEach(() => vi.resetAllMocks())

  it('getRecallStatus returns zeros for an unauthenticated user without hitting the DB', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect(await getRecallStatus()).toEqual({ chunks: 0, chats: 0 })
    expect(db.countChunks).not.toHaveBeenCalled()
  })

  it('getRecallStatus delegates with the user id', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(db.countChunks).mockResolvedValue({ chunks: 12, chats: 3 })
    expect(await getRecallStatus()).toEqual({ chunks: 12, chats: 3 })
    expect(db.countChunks).toHaveBeenCalledWith('u1')
  })

  it('mutations refuse when unauthenticated', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect(await setRecallEnabledAction(false)).toEqual({
      success: false,
      error: 'User not authenticated'
    })
    expect(await clearRecallIndexAction()).toEqual({
      success: false,
      error: 'User not authenticated'
    })
    expect(db.setRecallEnabled).not.toHaveBeenCalled()
    expect(db.clearChunks).not.toHaveBeenCalled()
  })

  it('rebuild delegates to backfillUser with a bounded slice and reports done when nothing is left', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(backfill.backfillUser).mockResolvedValue({
      messages: 4,
      chunks: 9
    })
    expect(await rebuildRecallIndexAction()).toEqual({
      success: true,
      messages: 4,
      chunks: 9,
      done: false
    })
    expect(backfill.backfillUser).toHaveBeenCalledWith('u1', {
      batchSize: 25,
      maxBatches: 4
    })

    vi.mocked(backfill.backfillUser).mockResolvedValue({
      messages: 0,
      chunks: 0
    })
    expect(await rebuildRecallIndexAction()).toEqual({
      success: true,
      messages: 0,
      chunks: 0,
      done: true
    })
  })
})
