import { revalidateTag } from 'next/cache'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { trackAccountDeleted } from '@/lib/analytics'
import { getCurrentUser } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'
import { deleteUserObjects } from '@/lib/storage/r2-client'
import { createAdminClient } from '@/lib/supabase/admin'

import { deleteAccount, updateEmail } from '../account'

vi.mock('@/lib/analytics')
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/actions')
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

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ENABLE_AUTH = 'true'

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

  afterEach(() => {
    process.env.ENABLE_AUTH = originalEnableAuth
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
