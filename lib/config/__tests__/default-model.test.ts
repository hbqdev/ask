import { afterEach, describe, expect, it, vi } from 'vitest'

// DEFAULT_MODEL is computed at module load from DEFAULT_CHAT_MODEL, so each
// case stubs the env and re-imports a fresh module instance.
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('DEFAULT_MODEL', () => {
  it('defaults to kimi-k2.6:cloud on ollama when DEFAULT_CHAT_MODEL is unset', async () => {
    vi.stubEnv('DEFAULT_CHAT_MODEL', '')
    vi.resetModules()
    const { DEFAULT_MODEL } = await import('../default-model')
    expect(DEFAULT_MODEL.id).toBe('kimi-k2.6:cloud')
    expect(DEFAULT_MODEL.name).toBe('kimi-k2.6:cloud')
    expect(DEFAULT_MODEL.providerId).toBe('ollama')
    expect(DEFAULT_MODEL.providerOptions?.ollama?.think).toBe(true)
  })

  it('honors DEFAULT_CHAT_MODEL from the environment', async () => {
    vi.stubEnv('DEFAULT_CHAT_MODEL', 'glm-5.2:cloud')
    vi.resetModules()
    const { DEFAULT_MODEL } = await import('../default-model')
    expect(DEFAULT_MODEL.id).toBe('glm-5.2:cloud')
    expect(DEFAULT_MODEL.name).toBe('glm-5.2:cloud')
    expect(DEFAULT_MODEL.providerId).toBe('ollama')
  })

  it('ignores a whitespace-only DEFAULT_CHAT_MODEL', async () => {
    vi.stubEnv('DEFAULT_CHAT_MODEL', '   ')
    vi.resetModules()
    const { DEFAULT_MODEL } = await import('../default-model')
    expect(DEFAULT_MODEL.id).toBe('kimi-k2.6:cloud')
  })
})
