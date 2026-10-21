import { Preferences } from '@capacitor/preferences'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { preferencesStorage } from '@/core/auth/preferences-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn()
  }
}))

const prefs = vi.mocked(Preferences)

describe('preferencesStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getItem reads the value from Preferences', async () => {
    prefs.get.mockResolvedValue({ value: 'stored-session' })
    await expect(preferencesStorage.getItem('sb-auth')).resolves.toBe(
      'stored-session'
    )
    expect(prefs.get).toHaveBeenCalledWith({ key: 'sb-auth' })
  })

  it('getItem returns null for a missing value', async () => {
    prefs.get.mockResolvedValue({ value: null })
    await expect(preferencesStorage.getItem('missing')).resolves.toBeNull()
  })

  it('setItem writes the value to Preferences', async () => {
    prefs.set.mockResolvedValue(undefined)
    await expect(
      preferencesStorage.setItem('sb-auth', 'new-session')
    ).resolves.toBeUndefined()
    expect(prefs.set).toHaveBeenCalledWith({
      key: 'sb-auth',
      value: 'new-session'
    })
  })

  it('removeItem removes the key from Preferences', async () => {
    prefs.remove.mockResolvedValue(undefined)
    await expect(preferencesStorage.removeItem('sb-auth')).resolves.toBeUndefined()
    expect(prefs.remove).toHaveBeenCalledWith({ key: 'sb-auth' })
  })
})
