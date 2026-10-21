import { vi } from 'vitest'

/** An in-memory stand-in for the Preferences storage adapter. */
export function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      data.delete(key)
    })
  }
}
