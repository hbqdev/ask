// Where supabase-js keeps the session: Capacitor Preferences, the app's
// native sandboxed key-value store (UserDefaults on iOS). Unlike WebView
// localStorage, iOS does not evict it, so a signed-in user stays signed in.

import { Preferences } from '@capacitor/preferences'

/** The async storage shape supabase-js accepts for `auth.storage`. */
export type AuthStorage = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export const preferencesStorage: AuthStorage = {
  async getItem(key) {
    const { value } = await Preferences.get({ key })
    return value ?? null
  },
  async setItem(key, value) {
    await Preferences.set({ key, value })
  },
  async removeItem(key) {
    await Preferences.remove({ key })
  }
}
