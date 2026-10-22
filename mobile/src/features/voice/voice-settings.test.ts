import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_VOICE_SETTINGS,
  loadVoiceSettings,
  parseVoiceSettings,
  saveVoiceSettings,
  useVoiceSettings,
  VOICE_SETTINGS_KEY
} from '@/features/voice/voice-settings'
import { DEFAULT_TTS_SPEED, DEFAULT_TTS_VOICE } from '@/lib/voice/voices'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseVoiceSettings', () => {
  it('defaults to Ask’s voice and speed, with auto-read off', () => {
    expect(DEFAULT_VOICE_SETTINGS).toEqual({
      voice: DEFAULT_TTS_VOICE,
      speed: DEFAULT_TTS_SPEED,
      autoRead: false
    })
    expect(VOICE_SETTINGS_KEY).toBe('ask-voice-settings')
    expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('reads stored settings', () => {
    expect(
      parseVoiceSettings(
        JSON.stringify({ voice: 'bm_george', speed: 0.9, autoRead: true })
      )
    ).toEqual({ voice: 'bm_george', speed: 0.9, autoRead: true })
  })

  it('falls back to the default for each invalid field', () => {
    expect(
      parseVoiceSettings(
        JSON.stringify({ voice: 'nobody', speed: 1.3, autoRead: 'yes' })
      )
    ).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(
      parseVoiceSettings(JSON.stringify({ voice: 3, speed: '1.4' }))
    ).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(
      parseVoiceSettings(JSON.stringify({ voice: 'af_sky', speed: 99 }))
    ).toEqual({ ...DEFAULT_VOICE_SETTINGS, voice: 'af_sky' })
  })

  it('falls back to the defaults for unparseable or non-object values', () => {
    expect(parseVoiceSettings('{nope')).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(parseVoiceSettings('"af_sky"')).toEqual(DEFAULT_VOICE_SETTINGS)
    expect(parseVoiceSettings('null')).toEqual(DEFAULT_VOICE_SETTINGS)
  })
})

describe('loadVoiceSettings / saveVoiceSettings', () => {
  it('round-trips through storage', async () => {
    const storage = memoryStorage()
    const settings = { voice: 'af_bella', speed: 1.6, autoRead: true }
    await saveVoiceSettings(settings, storage)
    expect(JSON.parse(storage.data.get(VOICE_SETTINGS_KEY)!)).toEqual(settings)
    expect(await loadVoiceSettings(storage)).toEqual(settings)
  })

  it('gives the defaults when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValueOnce(new Error('broken'))
    expect(await loadVoiceSettings(storage)).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('a load made while a save is being written reads the new settings', async () => {
    const storage = memoryStorage()
    let finish!: () => void
    storage.setItem.mockImplementationOnce(
      (key: string, value: string) =>
        new Promise<void>(resolve => {
          finish = () => {
            storage.data.set(key, value)
            resolve()
          }
        })
    )
    const saving = saveVoiceSettings(
      { ...DEFAULT_VOICE_SETTINGS, autoRead: true },
      storage
    )
    const loading = loadVoiceSettings(storage)
    finish()
    await saving
    expect((await loading).autoRead).toBe(true)
  })

  it('a failed save rejects, and does not hold up later loads', async () => {
    const storage = memoryStorage()
    storage.setItem.mockRejectedValueOnce(new Error('full'))
    await expect(
      saveVoiceSettings(DEFAULT_VOICE_SETTINGS, storage)
    ).rejects.toThrow('full')
    expect(await loadVoiceSettings(storage)).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('uses Capacitor Preferences by default', async () => {
    vi.mocked(Preferences.get).mockResolvedValueOnce({
      value: JSON.stringify({ voice: 'am_adam', speed: 1, autoRead: true })
    })
    expect(await loadVoiceSettings()).toEqual({
      voice: 'am_adam',
      speed: 1,
      autoRead: true
    })
    expect(Preferences.get).toHaveBeenCalledWith({ key: VOICE_SETTINGS_KEY })

    await saveVoiceSettings(DEFAULT_VOICE_SETTINGS)
    expect(Preferences.set).toHaveBeenCalledWith({
      key: VOICE_SETTINGS_KEY,
      value: JSON.stringify(DEFAULT_VOICE_SETTINGS)
    })
  })
})

describe('useVoiceSettings', () => {
  it('starts on the defaults and moves to the stored settings', async () => {
    const storage = memoryStorage({
      [VOICE_SETTINGS_KEY]: JSON.stringify({
        voice: 'bf_emma',
        speed: 1.4,
        autoRead: true
      })
    })
    const { result } = renderHook(() => useVoiceSettings(storage))
    expect(result.current[0]).toEqual(DEFAULT_VOICE_SETTINGS)
    await waitFor(() =>
      expect(result.current[0]).toEqual({
        voice: 'bf_emma',
        speed: 1.4,
        autoRead: true
      })
    )
  })

  it('shows a change at once and saves it', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useVoiceSettings(storage))
    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    act(() => result.current[1]({ ...DEFAULT_VOICE_SETTINGS, autoRead: true }))
    expect(result.current[0].autoRead).toBe(true)
    await waitFor(() =>
      expect(JSON.parse(storage.data.get(VOICE_SETTINGS_KEY)!).autoRead).toBe(
        true
      )
    )
  })

  it('two changes made before a render both stick, and both are saved', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useVoiceSettings(storage))
    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    const [, set] = result.current
    act(() => {
      set(current => ({ ...current, voice: 'bf_emma' }))
      set(current => ({ ...current, speed: 1.4 }))
    })
    expect(result.current[0]).toEqual({
      voice: 'bf_emma',
      speed: 1.4,
      autoRead: false
    })
    await waitFor(() =>
      expect(JSON.parse(storage.data.get(VOICE_SETTINGS_KEY)!)).toEqual({
        voice: 'bf_emma',
        speed: 1.4,
        autoRead: false
      })
    )
  })

  it('a slow load does not undo a change', async () => {
    const storage = memoryStorage({
      [VOICE_SETTINGS_KEY]: JSON.stringify({ voice: 'bf_emma' })
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const read = storage.getItem.getMockImplementation()!
    storage.getItem.mockImplementationOnce(async key => {
      await gate
      return read(key)
    })
    const { result } = renderHook(() => useVoiceSettings(storage))
    act(() =>
      result.current[1]({ ...DEFAULT_VOICE_SETTINGS, voice: 'am_adam' })
    )
    await act(async () => release())
    expect(result.current[0].voice).toBe('am_adam')
  })

  it('keeps a change on screen when it cannot be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    storage.setItem.mockRejectedValueOnce(new Error('full'))
    const { result } = renderHook(() => useVoiceSettings(storage))
    act(() => result.current[1]({ ...DEFAULT_VOICE_SETTINGS, speed: 0.9 }))
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Could not save the voice settings',
        expect.any(Error)
      )
    )
    expect(result.current[0].speed).toBe(0.9)
    warn.mockRestore()
  })
})
