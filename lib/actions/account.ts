'use server'

import { revalidateTag } from 'next/cache'

import { trackAccountDeleted } from '@/lib/analytics'
import { getCurrentUser } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'
import { deleteUserObjects } from '@/lib/storage/r2-client'
import { createAdminClient } from '@/lib/supabase/admin'

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Failed to delete account'
}

export async function deleteAccount(): Promise<{
  success: boolean
  error?: string
}> {
  if (process.env.ENABLE_AUTH === 'false') {
    return {
      success: false,
      error: 'Account deletion is unavailable in anonymous mode.'
    }
  }

  const user = await getCurrentUser()
  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  let adminClient: ReturnType<typeof createAdminClient>
  try {
    adminClient = createAdminClient()
  } catch (error) {
    console.error('Supabase admin client is not configured:', error)
    return {
      success: false,
      error: 'Account deletion is not configured. Set SUPABASE_SECRET_KEY.'
    }
  }

  try {
    const deleteChatsResult = await dbActions.deleteUserChats(user.id)
    if (!deleteChatsResult.success) {
      return {
        success: false,
        error: deleteChatsResult.error ?? 'Failed to delete account data'
      }
    }

    const deleteNotesResult = await dbActions.deleteUserNotes(user.id)
    if (!deleteNotesResult.success) {
      return {
        success: false,
        error: deleteNotesResult.error ?? 'Failed to delete account data'
      }
    }

    const deleteFilesResult = await dbActions.deleteUserLibraryFiles(user.id)
    if (!deleteFilesResult.success) {
      return {
        success: false,
        error: deleteFilesResult.error ?? 'Failed to delete account data'
      }
    }

    const anonymizeFeedbackResult = await dbActions.anonymizeUserFeedback(
      user.id
    )
    if (!anonymizeFeedbackResult.success) {
      return {
        success: false,
        error:
          anonymizeFeedbackResult.error ?? 'Failed to anonymize user feedback'
      }
    }

    await deleteUserObjects(user.id)

    const { error } = await adminClient.auth.admin.deleteUser(user.id)
    if (error) {
      throw error
    }

    revalidateTag('chat', 'max')
    await trackAccountDeleted(user.id)

    return { success: true }
  } catch (error) {
    console.error(`Error deleting account for user ${user.id}:`, error)
    return { success: false, error: getErrorMessage(error) }
  }
}

export async function updateEmail(
  newEmail: string
): Promise<{ success: boolean; error?: string }> {
  if (process.env.ENABLE_AUTH === 'false') {
    return {
      success: false,
      error: 'Email change is unavailable in anonymous mode.'
    }
  }

  const user = await getCurrentUser()
  if (!user) {
    return { success: false, error: 'User not authenticated' }
  }

  const email = newEmail.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: 'Enter a valid email address.' }
  }
  if (email === user.email?.toLowerCase()) {
    return { success: false, error: 'That is already your email address.' }
  }

  let adminClient: ReturnType<typeof createAdminClient>
  try {
    adminClient = createAdminClient()
  } catch (error) {
    console.error('Supabase admin client is not configured:', error)
    return {
      success: false,
      error: 'Email change is not configured. Set SUPABASE_SECRET_KEY.'
    }
  }

  // Service-role update, marked pre-confirmed — deliberately skips Supabase's
  // confirmation-email ceremony. Single-operator instance; same trust model
  // as deleteAccount above. Login identity switches to the new address
  // immediately; the existing session stays valid (same user id).
  const { error } = await adminClient.auth.admin.updateUserById(user.id, {
    email,
    email_confirm: true
  })
  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}
