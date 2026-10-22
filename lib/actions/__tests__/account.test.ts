import { revalidateTag } from 'next/cache'

import { existsSync, promises as fsPromises } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { trackAccountDeleted } from '@/lib/analytics'
import { getCurrentUser } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'
import * as memoryDb from '@/lib/db/memory-actions'
import { deleteUserObjects } from '@/lib/storage/r2-client'
import { createAdminClient } from '@/lib/supabase/admin'

import { deleteAccount, updateEmail } from '../account'

vi.mock('@/lib/analytics')
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/actions')
vi.mock('@/lib/db/memory-actions')
vi.mock('@/lib/storage/r2-client')
vi.mock('@/lib/supabase/admin')

const originalEnableAuth = process.env.ENABLE_AUTH

describe('Account Actions', () => {
  const user = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    email: 'old@fury.dev'
  }
  const deleteUser = vi.fn()
  const updateUserById = vi.fn()

  // Every test runs against a throwaway uploads root, never a real path.
  let uploadsDir: string
  const userUploads = () => path.join(uploadsDir, user.id)

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.ENABLE_AUTH = 'true'
    uploadsDir = await mkdtemp(path.join(tmpdir(), 'ask-account-test-'))
    vi.stubEnv('UPLOADS_DIR', uploadsDir)
    await mkdir(path.join(userUploads(), 'chats', 'c1'), { recursive: true })
    await writeFile(path.join(userUploads(), 'chats', 'c1', 'a.pdf'), 'x')
    await writeFile(
      path.join(userUploads(), 'chats', 'c1', 'a.pdf.chunks.json'),
      '[]'
    )
    await mkdir(path.join(userUploads(), 'generated', 'c1'), {
      recursive: true
    })
    await writeFile(path.join(userUploads(), 'generated', 'c1', 'i.webp'), 'x')
    await mkdir(path.join(uploadsDir, 'other-user', 'chats', 'c2'), {
      recursive: true
    })
    await writeFile(
      path.join(uploadsDir, 'other-user', 'chats', 'c2', 'b.pdf'),
      'y'
    )

    vi.mocked(memoryDb.clearMemories).mockResolvedValue()
    vi.mocked(memoryDb.deleteUserSettings).mockResolvedValue()

    vi.mocked(getCurrentUser).mockResolvedValue(user as any)
    vi.mocked(dbActions.deleteUserChats).mockResolvedValue({ success: true })
    vi.mocked(dbActions.deleteUserNotes).mockResolvedValue({ success: true })
    vi.mocked(dbActions.deleteUserLibraryFiles).mockResolvedValue({
      success: true
    })
    vi.mocked(dbActions.anonymizeUserFeedback).mockResolvedValue({
      success: true
    })
    vi.mocked(deleteUserObjects).mockResolvedValue({
      deletedCount: 0,
      skipped: true
    })
    vi.mocked(trackAccountDeleted).mockResolvedValue()
    deleteUser.mockResolvedValue({ data: { user: null }, error: null })
    updateUserById.mockResolvedValue({ data: { user: {} }, error: null })
    vi.mocked(createAdminClient).mockReturnValue({
      auth: { admin: { deleteUser, updateUserById } }
    } as any)
  })

  afterEach(async () => {
    process.env.ENABLE_AUTH = originalEnableAuth
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('returns an error in anonymous mode', async () => {
    process.env.ENABLE_AUTH = 'false'

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Account deletion is unavailable in anonymous mode.'
    })
    expect(getCurrentUser).not.toHaveBeenCalled()
    expect(dbActions.deleteUserChats).not.toHaveBeenCalled()
  })

  it('returns an error when the user is not authenticated', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'User not authenticated'
    })
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(dbActions.deleteUserChats).not.toHaveBeenCalled()
  })

  it('returns an error when Supabase admin is not configured', async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error('Missing secret key')
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Account deletion is not configured. Set SUPABASE_SECRET_KEY.'
    })
    expect(dbActions.deleteUserChats).not.toHaveBeenCalled()
  })

  it('deletes app data, anonymizes feedback, uploaded files, and auth user', async () => {
    const result = await deleteAccount()

    expect(result).toEqual({ success: true })
    expect(dbActions.deleteUserChats).toHaveBeenCalledWith(user.id)
    expect(dbActions.deleteUserNotes).toHaveBeenCalledWith(user.id)
    expect(dbActions.deleteUserLibraryFiles).toHaveBeenCalledWith(user.id)
    expect(dbActions.anonymizeUserFeedback).toHaveBeenCalledWith(user.id)
    expect(deleteUserObjects).toHaveBeenCalledWith(user.id)
    expect(deleteUser).toHaveBeenCalledWith(user.id)
    expect(revalidateTag).toHaveBeenCalledWith('chat', 'max')
    expect(trackAccountDeleted).toHaveBeenCalledTimes(1)
  })

  it('deletes memories, settings and uploads', async () => {
    const result = await deleteAccount()

    expect(result).toEqual({ success: true })
    expect(memoryDb.clearMemories).toHaveBeenCalledWith(user.id)
    expect(memoryDb.deleteUserSettings).toHaveBeenCalledWith(user.id)
    expect(await readdir(uploadsDir)).toEqual(['other-user'])

    // Every DB step runs before the auth user is deleted.
    const order = (fn: unknown) =>
      vi.mocked(fn as (...args: any[]) => unknown).mock.invocationCallOrder[0]
    const dbSteps = [
      memoryDb.clearMemories,
      memoryDb.deleteUserSettings,
      dbActions.deleteUserChats,
      dbActions.deleteUserNotes,
      dbActions.deleteUserLibraryFiles,
      dbActions.anonymizeUserFeedback,
      deleteUserObjects
    ]
    for (let i = 1; i < dbSteps.length; i++) {
      expect(order(dbSteps[i - 1])).toBeLessThan(order(dbSteps[i]))
    }
    expect(order(deleteUserObjects)).toBeLessThan(order(deleteUser))
  })

  it('files are removed only after the auth user is deleted', async () => {
    let uploadsPresentAtAuthDelete: boolean | undefined
    deleteUser.mockImplementation(async () => {
      uploadsPresentAtAuthDelete = existsSync(userUploads())
      return { data: { user: null }, error: null }
    })

    const result = await deleteAccount()

    expect(result).toEqual({ success: true })
    expect(uploadsPresentAtAuthDelete).toBe(true)
    expect(existsSync(userUploads())).toBe(false)
  })

  it.each([
    [
      'memories',
      () =>
        vi.mocked(memoryDb.clearMemories).mockRejectedValue(new Error('db')),
      'Failed to delete user memories'
    ],
    [
      'settings',
      () =>
        vi
          .mocked(memoryDb.deleteUserSettings)
          .mockRejectedValue(new Error('db')),
      'Failed to delete user settings'
    ],
    [
      'chats',
      () =>
        vi
          .mocked(dbActions.deleteUserChats)
          .mockResolvedValue({ success: false, error: 'chats failed' }),
      'chats failed'
    ],
    [
      'notes',
      () =>
        vi
          .mocked(dbActions.deleteUserNotes)
          .mockResolvedValue({ success: false, error: 'notes failed' }),
      'notes failed'
    ],
    [
      'library file rows',
      () =>
        vi
          .mocked(dbActions.deleteUserLibraryFiles)
          .mockResolvedValue({ success: false, error: 'files failed' }),
      'files failed'
    ],
    [
      'feedback anonymization',
      () =>
        vi
          .mocked(dbActions.anonymizeUserFeedback)
          .mockResolvedValue({ success: false, error: 'feedback failed' }),
      'feedback failed'
    ],
    [
      'a thrown DB error',
      () =>
        vi
          .mocked(dbActions.deleteUserNotes)
          .mockRejectedValue(new Error('connection reset')),
      'connection reset'
    ]
  ])(
    'a DB step failure (%s) deletes no files and keeps the account',
    async (_label, fail, message) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      fail()

      const result = await deleteAccount()

      expect(result).toEqual({ success: false, error: message })
      expect(existsSync(userUploads())).toBe(true)
      expect(deleteUser).not.toHaveBeenCalled()
      expect(trackAccountDeleted).not.toHaveBeenCalled()
    }
  )

  it('an auth-delete failure deletes no files', async () => {
    deleteUser.mockResolvedValue({
      data: { user: null },
      error: new Error('Auth deletion failed')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await deleteAccount()

    expect(result).toEqual({ success: false, error: 'Auth deletion failed' })
    expect(existsSync(userUploads())).toBe(true)
  })

  it('an fs failure after auth deletion still returns ok', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fsPromises, 'rm').mockRejectedValueOnce(new Error('EBUSY'))

    const result = await deleteAccount()

    expect(result).toEqual({ success: true })
    expect(deleteUser).toHaveBeenCalledWith(user.id)
    expect(trackAccountDeleted).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalled()
  })

  it('the uploads-path guard rejects a traversal id and touches no files', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const traversal = { id: '../' + path.basename(uploadsDir), email: 'x@y.z' }
    vi.mocked(getCurrentUser).mockResolvedValue(traversal as any)

    const result = await deleteAccount()

    expect(result).toEqual({ success: true })
    expect((await readdir(uploadsDir)).sort()).toEqual(
      [user.id, 'other-user'].sort()
    )
    expect(deleteUser).toHaveBeenCalledWith(traversal.id)
    expect(error).toHaveBeenCalled()
  })

  it('stops before storage and auth deletion when app data deletion fails', async () => {
    vi.mocked(dbActions.deleteUserChats).mockResolvedValue({
      success: false,
      error: 'Failed to delete user chats'
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Failed to delete user chats'
    })
    expect(deleteUserObjects).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  it('stops before storage and auth deletion when notes deletion fails', async () => {
    vi.mocked(dbActions.deleteUserNotes).mockResolvedValue({
      success: false,
      error: 'Failed to delete user notes'
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Failed to delete user notes'
    })
    expect(deleteUserObjects).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  it('stops before storage and auth deletion when feedback anonymization fails', async () => {
    vi.mocked(dbActions.anonymizeUserFeedback).mockResolvedValue({
      success: false,
      error: 'Failed to anonymize user feedback'
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Failed to anonymize user feedback'
    })
    expect(deleteUserObjects).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  it('stops before storage and auth deletion when library file deletion fails', async () => {
    vi.mocked(dbActions.deleteUserLibraryFiles).mockResolvedValue({
      success: false,
      error: 'Failed to delete user files'
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Failed to delete user files'
    })
    expect(deleteUserObjects).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  it('stops before auth deletion when uploaded file deletion fails', async () => {
    vi.mocked(deleteUserObjects).mockRejectedValue(new Error('Storage error'))

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Storage error'
    })
    expect(dbActions.deleteUserChats).toHaveBeenCalledWith(user.id)
    expect(dbActions.deleteUserNotes).toHaveBeenCalledWith(user.id)
    expect(dbActions.deleteUserLibraryFiles).toHaveBeenCalledWith(user.id)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  it('does not track account deletion when auth deletion fails', async () => {
    deleteUser.mockResolvedValue({
      data: { user: null },
      error: new Error('Auth deletion failed')
    })

    const result = await deleteAccount()

    expect(result).toEqual({
      success: false,
      error: 'Auth deletion failed'
    })
    expect(trackAccountDeleted).not.toHaveBeenCalled()
  })

  describe('updateEmail', () => {
    it('returns an error in anonymous mode', async () => {
      process.env.ENABLE_AUTH = 'false'

      const result = await updateEmail('new@fury.dev')

      expect(result.success).toBe(false)
      expect(getCurrentUser).not.toHaveBeenCalled()
    })

    it('returns an error when the user is not authenticated', async () => {
      vi.mocked(getCurrentUser).mockResolvedValue(null)

      const result = await updateEmail('new@fury.dev')

      expect(result).toEqual({
        success: false,
        error: 'User not authenticated'
      })
      expect(createAdminClient).not.toHaveBeenCalled()
    })

    it('rejects an invalid email address without calling Supabase', async () => {
      const result = await updateEmail('not-an-email')

      expect(result.success).toBe(false)
      expect(updateUserById).not.toHaveBeenCalled()
    })

    it('rejects the current address without calling Supabase', async () => {
      const result = await updateEmail('  OLD@fury.dev ')

      expect(result.success).toBe(false)
      expect(updateUserById).not.toHaveBeenCalled()
    })

    it('updates the Supabase user pre-confirmed and normalizes the address', async () => {
      const result = await updateEmail('  New@Fury.dev ')

      expect(updateUserById).toHaveBeenCalledWith(user.id, {
        email: 'new@fury.dev',
        email_confirm: true
      })
      expect(result).toEqual({ success: true })
    })

    it('surfaces Supabase errors (e.g. address already registered)', async () => {
      updateUserById.mockResolvedValue({
        data: { user: null },
        error: {
          message: 'A user with this email address has already been registered'
        }
      })

      const result = await updateEmail('taken@fury.dev')

      expect(result).toEqual({
        success: false,
        error: 'A user with this email address has already been registered'
      })
    })
  })
})
