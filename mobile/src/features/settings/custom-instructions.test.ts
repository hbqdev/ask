import { Preferences } from '@capacitor/preferences'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CUSTOM_INSTRUCTIONS_KEY,
  CUSTOM_INSTRUCTIONS_MAX,
  loadCustomInstructions,
  normalizeCustomInstructions,
  saveCustomInstructions
} from '@/features/settings/custom-instructions'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('normalizeCustomInstructions', () => {
  it('trims and caps at 4000 characters', () => {
    expect(CUSTOM_INSTRUCTIONS_MAX).toBe(4000)
    expect(normalizeCustomInstructions('  Be brief.\n ')).toBe('Be brief.')
    expect(normalizeCustomInstructions('x'.repeat(4100))).toHaveLength(4000)
  })

  it('leaves no trailing space where the cap cuts', () => {
    const text = `${'x'.repeat(3999)} tail`
    expect(normalizeCustomInstructions(text)).toBe('x'.repeat(3999))
  })
})

describe('custom instructions storage', () => {
  it('round trips through the ask-system-instructions key', async () => {
    const storage = memoryStorage()
    await saveCustomInstructions('Use British English.', storage)
    expect(CUSTOM_INSTRUCTIONS_KEY).toBe('ask-system-instructions')
    expect(storage.data.get(CUSTOM_INSTRUCTIONS_KEY)).toBe(
      'Use British English.'
    )
    await expect(loadCustomInstructions(storage)).resolves.toBe(
      'Use British English.'
    )
  })

  it('saves the text trimmed and capped', async () => {
    const storage = memoryStorage()
    await saveCustomInstructions(`  ${'y'.repeat(4500)}  `, storage)
    expect(storage.data.get(CUSTOM_INSTRUCTIONS_KEY)).toBe('y'.repeat(4000))
  })

  it('removes the key when the text is empty or only whitespace', async () => {
    const storage = memoryStorage({ [CUSTOM_INSTRUCTIONS_KEY]: 'old' })
    await saveCustomInstructions('  \n ', storage)
    expect(storage.data.has(CUSTOM_INSTRUCTIONS_KEY)).toBe(false)
    await expect(loadCustomInstructions(storage)).resolves.toBe('')
  })

  it('loads a stored value trimmed and capped', async () => {
    const storage = memoryStorage({
      [CUSTOM_INSTRUCTIONS_KEY]: ` ${'z'.repeat(4001)}`
    })
    await expect(loadCustomInstructions(storage)).resolves.toBe(
      'z'.repeat(4000)
    )
  })

  it('loads an empty string when nothing is stored', async () => {
    await expect(loadCustomInstructions(memoryStorage())).resolves.toBe('')
  })

  it('loads an empty string when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unavailable'))
    await expect(loadCustomInstructions(storage)).resolves.toBe('')
  })

  it('a load waits for a save still being written', async () => {
    const storage = memoryStorage()
    let finish: () => void = () => {}
    storage.setItem.mockImplementationOnce(
      (key, value) =>
        new Promise<void>(resolve => {
          finish = () => {
            storage.data.set(key, value)
            resolve()
          }
        })
    )
    const saving = saveCustomInstructions('New text', storage)
    const loading = loadCustomInstructions(storage)
    await Promise.resolve()
    expect(storage.getItem).not.toHaveBeenCalled()
    finish()
    await saving
    await expect(loading).resolves.toBe('New text')
  })

  it('a failed save rejects, and a later load still reads', async () => {
    const storage = memoryStorage({ [CUSTOM_INSTRUCTIONS_KEY]: 'kept' })
    storage.setItem.mockRejectedValueOnce(new Error('full'))
    await expect(saveCustomInstructions('lost', storage)).rejects.toThrow(
      'full'
    )
    await expect(loadCustomInstructions(storage)).resolves.toBe('kept')
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.set.mockResolvedValue(undefined)
    await saveCustomInstructions('Be kind.')
    expect(prefs.set).toHaveBeenCalledWith({
      key: CUSTOM_INSTRUCTIONS_KEY,
      value: 'Be kind.'
    })
    prefs.get.mockResolvedValue({ value: 'Be kind.' })
    await expect(loadCustomInstructions()).resolves.toBe('Be kind.')
    expect(prefs.get).toHaveBeenCalledWith({ key: CUSTOM_INSTRUCTIONS_KEY })
  })
})
