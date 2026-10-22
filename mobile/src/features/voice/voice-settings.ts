// How answers are read aloud: the Kokoro voice, the speed, and whether a new
// answer is read by itself (auto-read). Kept on this device in Capacitor
// Preferences, as the web keeps them in localStorage, and read afresh for
// each question and each reading, so a change in Settings applies at once.

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  isValidVoice,
  TTS_SPEEDS
} from '@/lib/voice/voices'

export type VoiceSettings = {
  /** A Kokoro voice id from TTS_VOICES. */
  voice: string
  /** A speed multiplier from TTS_SPEEDS. */
  speed: number
  /** Read each answer to a question sent from the thread aloud by itself. */
  autoRead: boolean
}

/** The Preferences key that holds the settings, as JSON. */
export const VOICE_SETTINGS_KEY = 'ask-voice-settings'

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voice: DEFAULT_TTS_VOICE,
  speed: DEFAULT_TTS_SPEED,
  autoRead: false
}

const isOfferedSpeed = (value: unknown): value is number =>
  typeof value === 'number' && TTS_SPEEDS.some(s => Number(s.value) === value)

/**
 * A stored value as settings. A missing, unparseable or invalid field (a
 * voice or speed Settings doesn't offer) falls back to its default.
 */
export function parseVoiceSettings(value: string | null): VoiceSettings {
  let stored: unknown
  try {
    stored = value === null ? null : JSON.parse(value)
  } catch {
    stored = null
  }
  const fields =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)
      : {}
  return {
    voice: isValidVoice(fields.voice)
      ? fields.voice
      : DEFAULT_VOICE_SETTINGS.voice,
    speed: isOfferedSpeed(fields.speed)
      ? fields.speed
      : DEFAULT_VOICE_SETTINGS.speed,
    autoRead:
      typeof fields.autoRead === 'boolean'
        ? fields.autoRead
        : DEFAULT_VOICE_SETTINGS.autoRead
  }
}

// The last save, so a load made while it is still being written reads the
// new settings (a question asked right after leaving Settings carries them).
let lastSave: Promise<unknown> = Promise.resolve()

/** The saved settings, or the defaults when there are none or storage fails. */
export async function loadVoiceSettings(
  storage: AuthStorage = preferencesStorage
): Promise<VoiceSettings> {
  await lastSave
  try {
    return parseVoiceSettings(await storage.getItem(VOICE_SETTINGS_KEY))
  } catch {
    return DEFAULT_VOICE_SETTINGS
  }
}

export function saveVoiceSettings(
  settings: VoiceSettings,
  storage: AuthStorage = preferencesStorage
): Promise<void> {
  const save = storage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings))
  lastSave = save.catch(() => {})
  return save
}

/** New settings, or how to make them from the latest ones. */
export type VoiceSettingsChange =
  | VoiceSettings
  | ((current: VoiceSettings) => VoiceSettings)

/**
 * The settings and a setter. It starts on the defaults and moves to the
 * stored settings once they load; a change shows at once and is saved in the
 * background (a failed save only costs the change at the next launch). A
 * change given as a function builds on the latest settings, even ones not
 * rendered yet, so two quick changes both stick.
 */
export function useVoiceSettings(
  storage: AuthStorage = preferencesStorage
): [VoiceSettings, (change: VoiceSettingsChange) => void] {
  const [settings, setSettings] = useState(DEFAULT_VOICE_SETTINGS)
  // The latest settings, ahead of the render that shows them.
  const latest = useRef(settings)
  // Set once the user changes something, so a slow load cannot undo it.
  const changed = useRef(false)

  useEffect(() => {
    void loadVoiceSettings(storage).then(stored => {
      if (changed.current) return
      latest.current = stored
      setSettings(stored)
    })
  }, [storage])

  const update = useCallback(
    (change: VoiceSettingsChange) => {
      const next =
        typeof change === 'function' ? change(latest.current) : change
      changed.current = true
      latest.current = next
      setSettings(next)
      saveVoiceSettings(next, storage).catch(error => {
        console.warn('Could not save the voice settings', error)
      })
    },
    [storage]
  )

  return [settings, update]
}
