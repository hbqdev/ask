// The user's custom instructions: free text sent with every question (the
// chat route appends it to the prompt as "User instructions"). Kept on this
// device in Capacitor Preferences, as the web keeps it in localStorage, and
// read afresh for each question so a change in Settings applies to the next
// one.

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'

/** The Preferences key that holds the instructions. */
export const CUSTOM_INSTRUCTIONS_KEY = 'ask-system-instructions'

/** The longest instructions kept, in characters. */
export const CUSTOM_INSTRUCTIONS_MAX = 4000

/** Trimmed and cut to CUSTOM_INSTRUCTIONS_MAX characters. */
export function normalizeCustomInstructions(text: string): string {
  return text.trim().slice(0, CUSTOM_INSTRUCTIONS_MAX).trimEnd()
}

// The last save, so a load made while it is still being written reads the
// new text (a question asked right after leaving Settings carries it).
let lastSave: Promise<unknown> = Promise.resolve()

/** The saved instructions, or '' when there are none or storage fails. */
export async function loadCustomInstructions(
  storage: AuthStorage = preferencesStorage
): Promise<string> {
  await lastSave
  try {
    return normalizeCustomInstructions(
      (await storage.getItem(CUSTOM_INSTRUCTIONS_KEY)) ?? ''
    )
  } catch {
    return ''
  }
}

/** Saves the instructions; empty (after trimming) removes them. */
export function saveCustomInstructions(
  text: string,
  storage: AuthStorage = preferencesStorage
): Promise<void> {
  const value = normalizeCustomInstructions(text)
  const save = value
    ? storage.setItem(CUSTOM_INSTRUCTIONS_KEY, value)
    : storage.removeItem(CUSTOM_INSTRUCTIONS_KEY)
  lastSave = save.catch(() => {})
  return save
}
