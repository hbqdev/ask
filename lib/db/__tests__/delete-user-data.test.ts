import { beforeEach, describe, expect, it, vi } from 'vitest'

// withRLS (real) runs its callback inside db.transaction. A rejected
// transaction must land in each function's own catch and come back as
// {success:false, error}, never as a raw rejection with the DB's message.
vi.mock('@/lib/db', () => ({
  db: { transaction: vi.fn() }
}))

import { db } from '@/lib/db'

import {
  anonymizeUserFeedback,
  deleteUserChats,
  deleteUserLibraryFiles,
  deleteUserNotes
} from '../actions'

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe.each([
  ['deleteUserChats', deleteUserChats, 'Failed to delete user chats'],
  ['deleteUserNotes', deleteUserNotes, 'Failed to delete user notes'],
  [
    'deleteUserLibraryFiles',
    deleteUserLibraryFiles,
    'Failed to delete user files'
  ],
  [
    'anonymizeUserFeedback',
    anonymizeUserFeedback,
    'Failed to anonymize user feedback'
  ]
])('%s', (_name, fn, message) => {
  it('returns its own error when the DB rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(db.transaction).mockRejectedValue(new Error('connection reset'))

    await expect(fn('user-1')).resolves.toEqual({
      success: false,
      error: message
    })
    expect(error).toHaveBeenCalled()
  })

  it('returns success when the transaction commits', async () => {
    const tx: any = {
      execute: vi.fn().mockResolvedValue(undefined),
      delete: () => ({ where: () => Promise.resolve() }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) })
    }
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx))

    await expect(fn('user-1')).resolves.toEqual({ success: true })
  })
})
