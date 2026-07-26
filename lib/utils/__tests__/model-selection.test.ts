import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isCloudDeployment } from '@/lib/config/load-models-config'
import { MODEL_SELECTION_COOKIE } from '@/lib/config/model-selection-cookie'
import type { Model } from '@/lib/types/models'
import type { SearchMode } from '@/lib/types/search'

vi.mock('@/lib/config/load-models-config')
vi.mock('@/lib/config/model-types')
vi.mock('@/lib/utils/registry')
vi.mock('@/lib/db/model-preference-actions', () => ({
  getPreferredChatModel: vi.fn()
}))

import { getModelForMode } from '@/lib/config/model-types'
import { getPreferredChatModel } from '@/lib/db/model-preference-actions'
import { DEFAULT_MODEL, selectModel } from '@/lib/utils/model-selection'
import { thinkEnabledForOllama } from '@/lib/utils/ollama-think'
import { isProviderEnabled } from '@/lib/utils/registry'

const mockIsCloudDeployment = vi.mocked(isCloudDeployment)
const mockGetModelForMode = vi.mocked(getModelForMode)
const mockIsProviderEnabled = vi.mocked(isProviderEnabled)
const mockGetPreferredChatModel = vi.mocked(getPreferredChatModel)

type Matrix = Partial<Record<SearchMode, Model>>

const speedModel: Model = {
  id: 'speed',
  name: 'Speed',
  provider: 'Provider A',
  providerId: 'provider-a'
}

const balancedModel: Model = {
  id: 'balanced',
  name: 'Balanced',
  provider: 'Provider B',
  providerId: 'provider-b'
}

let matrix: Matrix

function setMatrixImplementation() {
  mockGetModelForMode.mockImplementation((mode: SearchMode) => matrix[mode])
}

function createCookieStore(value?: string) {
  return {
    get: (name: string) => {
      if (name === MODEL_SELECTION_COOKIE && value) {
        return { name, value } as { name: string; value: string }
      }

      return undefined
    }
  } as any
}

describe('selectModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsCloudDeployment.mockReturnValue(true)
    matrix = {
      speed: speedModel,
      balanced: balancedModel
    }
    setMatrixImplementation()
    mockIsProviderEnabled.mockReturnValue(true)
  })

  it('returns the cloud model for the active mode when available', async () => {
    const result = await selectModel({
      searchMode: 'speed',
      cookieStore: createCookieStore()
    })
    expect(result).toEqual(speedModel)
  })

  it('falls back to the next mode when active mode provider is disabled', async () => {
    mockIsProviderEnabled.mockImplementation(providerId =>
      providerId === 'provider-a' ? false : true
    )

    const result = await selectModel({
      searchMode: 'speed',
      cookieStore: createCookieStore()
    })

    expect(result).toEqual(balancedModel)
  })

  it('falls back to balanced mode when search mode is omitted', async () => {
    const result = await selectModel({ cookieStore: createCookieStore() })
    expect(result).toEqual(balancedModel)
  })

  it('falls back to DEFAULT_MODEL when cloud models are unavailable', async () => {
    matrix = {}
    setMatrixImplementation()
    const result = await selectModel({
      searchMode: 'speed',
      cookieStore: createCookieStore()
    })
    expect(result).toEqual(DEFAULT_MODEL)
  })

  it('falls back to DEFAULT_MODEL when configured providers are disabled', async () => {
    mockIsProviderEnabled.mockImplementation(providerId =>
      providerId === 'provider-a' || providerId === 'provider-b' ? false : true
    )

    const result = await selectModel({
      searchMode: 'speed',
      cookieStore: createCookieStore()
    })

    expect(result).toEqual(DEFAULT_MODEL)
  })

  it('returns cookie-selected model in local/docker mode', async () => {
    mockIsCloudDeployment.mockReturnValue(false)
    mockIsProviderEnabled.mockImplementation(
      providerId => providerId === 'provider-l'
    )

    const result = await selectModel({
      cookieStore: createCookieStore('provider-l:local-model')
    })
    expect(result).toEqual({
      id: 'local-model',
      name: 'local-model',
      provider: 'provider-l',
      providerId: 'provider-l'
    })
  })

  it("authed: the account's saved pick wins and the cookie is ignored", async () => {
    mockIsCloudDeployment.mockReturnValue(false)
    mockIsProviderEnabled.mockReturnValue(true)
    mockGetPreferredChatModel.mockResolvedValue({
      providerId: 'ollama',
      modelId: 'account-model:cloud'
    })

    const result = await selectModel({
      cookieStore: createCookieStore('provider-l:cookie-model'),
      userId: 'u1'
    })

    expect(mockGetPreferredChatModel).toHaveBeenCalledWith('u1')
    expect(result?.id).toBe('account-model:cloud')
  })

  it('authed with no saved pick falls to DEFAULT_MODEL despite a cookie', async () => {
    mockIsCloudDeployment.mockReturnValue(false)
    mockIsProviderEnabled.mockReturnValue(true)
    mockGetPreferredChatModel.mockResolvedValue(null)

    const result = await selectModel({
      cookieStore: createCookieStore('provider-l:cookie-model'),
      userId: 'u1'
    })

    expect(result).toEqual(DEFAULT_MODEL)
  })

  it('authed saved pick with a disabled provider falls through to DEFAULT_MODEL', async () => {
    mockIsCloudDeployment.mockReturnValue(false)
    mockGetPreferredChatModel.mockResolvedValue({
      providerId: 'disabled-provider',
      modelId: 'x'
    })
    mockIsProviderEnabled.mockImplementation(
      providerId => providerId !== 'disabled-provider'
    )

    const result = await selectModel({ userId: 'u1' })

    expect(result).toEqual(DEFAULT_MODEL)
  })

  it('guest (no userId) never touches the account store', async () => {
    mockIsCloudDeployment.mockReturnValue(false)
    mockIsProviderEnabled.mockReturnValue(true)

    await selectModel({
      cookieStore: createCookieStore('provider-l:cookie-model')
    })

    expect(mockGetPreferredChatModel).not.toHaveBeenCalled()
  })
})

// Measured on prod: a 131.7s turn spent 85.4s between the search finishing and
// the first word, and persisted ONE reasoning block of 38,684 characters
// against an 8,730-character answer — 13,862 completion tokens total. think is
// hardcoded on for every Ollama model on every turn, so a factual lookup pays
// the same deliberation as a research synthesis. This is larger than every
// stage optimised so far combined, and it has never been A/B'd.
describe('OLLAMA_THINK', () => {
  afterEach(() => {
    delete process.env.OLLAMA_THINK
  })

  it('defaults to thinking ON, preserving current behaviour', () => {
    delete process.env.OLLAMA_THINK
    expect(thinkEnabledForOllama()).toBe(true)
  })

  it('turns thinking off only for the exact string false', () => {
    process.env.OLLAMA_THINK = 'false'
    expect(thinkEnabledForOllama()).toBe(false)
  })

  it('treats any other value as on, so a typo cannot silently disable it', () => {
    for (const v of ['no', '0', 'off', 'FALSE', '']) {
      process.env.OLLAMA_THINK = v
      expect(thinkEnabledForOllama()).toBe(true)
    }
  })
})
