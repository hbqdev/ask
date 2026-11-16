import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/utils/registry', () => ({
  isProviderEnabled: vi.fn()
}))

import * as fetchModels from '@/lib/models/fetch-models'
import {
  __resetOllamaReleaseDatesCache,
  fetchOllamaReleaseDates,
  ollamaBaseName,
  releaseDateFor,
  sortByReleaseDate
} from '@/lib/models/ollama-release-order'
import { Model } from '@/lib/types/models'
import { isProviderEnabled } from '@/lib/utils/registry'

const mockIsProviderEnabled = vi.mocked(isProviderEnabled)

const ms = (iso: string) => Date.parse(iso)

const model = (id: string): Model => ({
  id,
  name: id,
  provider: 'Ollama Cloud',
  providerId: 'ollama'
})

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body
  }
}

const TAGS = {
  models: [
    { name: 'deepseek-v4.1-flash', modified_at: '2026-09-10T00:00:00Z' },
    { name: 'deepseek-v4.1-flash:1017', modified_at: '2026-10-17T00:00:00Z' },
    { name: 'deepseek-v4-pro:0813', modified_at: '2026-08-13T00:00:00Z' },
    { name: 'kimi-k3.1-pro', modified_at: '2026-11-07T00:00:00Z' },
    { name: 'kimi-k3', modified_at: '2026-06-01T00:00:00Z' },
    { name: 'glm-5', modified_at: '2026-10-17T00:00:00Z' }
  ]
}

describe('ollamaBaseName', () => {
  it('strips a trailing :cloud', () => {
    expect(ollamaBaseName('kimi-k3:cloud')).toBe('kimi-k3')
    expect(ollamaBaseName('deepseek-v4-pro:0813:cloud')).toBe(
      'deepseek-v4-pro:0813'
    )
  })

  it('uses the part before ":" for ids without :cloud', () => {
    expect(ollamaBaseName('llama3.2:3b')).toBe('llama3.2')
    expect(ollamaBaseName('glm-5')).toBe('glm-5')
  })
})

describe('releaseDateFor', () => {
  const dates = new Map(
    TAGS.models.map(m => [m.name, ms(m.modified_at)] as const)
  )

  it('takes the newest revision among exact and tagged names', () => {
    expect(releaseDateFor('deepseek-v4.1-flash', dates)).toBe(
      ms('2026-10-17T00:00:00Z')
    )
  })

  it('matches a tagged-only revision', () => {
    expect(releaseDateFor('deepseek-v4-pro', dates)).toBe(
      ms('2026-08-13T00:00:00Z')
    )
  })

  it('does not treat a longer name as a revision', () => {
    expect(releaseDateFor('kimi-k3', dates)).toBe(ms('2026-06-01T00:00:00Z'))
  })

  it('returns undefined when nothing matches', () => {
    expect(releaseDateFor('qwen9', dates)).toBeUndefined()
  })
})

describe('sortByReleaseDate', () => {
  it('orders newest first, ties by name, undated last by name', () => {
    const dates = new Map(
      TAGS.models.map(m => [m.name, ms(m.modified_at)] as const)
    )
    const sorted = sortByReleaseDate(
      [
        model('zeta:cloud'),
        model('kimi-k3:cloud'),
        model('glm-5:cloud'),
        model('alpha:cloud'),
        model('deepseek-v4.1-flash:cloud'),
        model('kimi-k3.1-pro:cloud'),
        model('deepseek-v4-pro:cloud')
      ],
      dates
    )
    expect(sorted.map(m => m.id)).toEqual([
      'kimi-k3.1-pro:cloud',
      'deepseek-v4.1-flash:cloud',
      'glm-5:cloud',
      'deepseek-v4-pro:cloud',
      'kimi-k3:cloud',
      'alpha:cloud',
      'zeta:cloud'
    ])
  })

  it('falls back to name order with an empty map', () => {
    const sorted = sortByReleaseDate(
      [model('b:cloud'), model('c:cloud'), model('a:cloud')],
      new Map()
    )
    expect(sorted.map(m => m.id)).toEqual(['a:cloud', 'b:cloud', 'c:cloud'])
  })
})

describe('fetchOllamaReleaseDates', () => {
  beforeEach(() => {
    __resetOllamaReleaseDatesCache()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T00:00:00Z'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.OLLAMA_LIBRARY_TAGS_URL
  })

  it('fetches the default URL with no identifying headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(TAGS))
    vi.stubGlobal('fetch', fetchMock)

    const dates = await fetchOllamaReleaseDates()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ollama.com/api/tags')
    expect(init.headers).toBeUndefined()
    expect(init.signal).toBeDefined()
    expect(dates.get('deepseek-v4.1-flash:1017')).toBe(
      ms('2026-10-17T00:00:00Z')
    )
  })

  it('reads OLLAMA_LIBRARY_TAGS_URL per call', async () => {
    process.env.OLLAMA_LIBRARY_TAGS_URL = 'http://mirror.local/tags'
    const fetchMock = vi.fn().mockResolvedValue(okResponse(TAGS))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOllamaReleaseDates()
    expect(fetchMock.mock.calls[0][0]).toBe('http://mirror.local/tags')
  })

  it('caches a success for 6 hours', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(TAGS))
    vi.stubGlobal('fetch', fetchMock)

    await fetchOllamaReleaseDates()
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1000)
    const again = await fetchOllamaReleaseDates()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(again.size).toBe(TAGS.models.length)

    vi.advanceTimersByTime(2000)
    await fetchOllamaReleaseDates()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns an empty map on network failure and retries after 5 minutes', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchOllamaReleaseDates()).resolves.toEqual(new Map())
    vi.advanceTimersByTime(4 * 60 * 1000)
    await expect(fetchOllamaReleaseDates()).resolves.toEqual(new Map())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2 * 60 * 1000)
    fetchMock.mockResolvedValue(okResponse(TAGS))
    const dates = await fetchOllamaReleaseDates()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(dates.size).toBe(TAGS.models.length)
  })

  it('returns an empty map on non-200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        json: async () => TAGS
      })
    )
    await expect(fetchOllamaReleaseDates()).resolves.toEqual(new Map())
  })

  it('returns an empty map on bad JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        }
      })
    )
    await expect(fetchOllamaReleaseDates()).resolves.toEqual(new Map())
  })

  it('returns an empty map when the payload has no models array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ nope: 1 })))
    await expect(fetchOllamaReleaseDates()).resolves.toEqual(new Map())
  })
})

describe('fetchOllamaModels static list ordering', () => {
  beforeEach(() => {
    __resetOllamaReleaseDatesCache()
    mockIsProviderEnabled.mockImplementation(
      providerId => providerId === 'ollama'
    )
    process.env.OLLAMA_MODELS =
      'zeta:cloud,kimi-k3:cloud,deepseek-v4.1-flash:cloud,kimi-k3.1-pro:cloud,deepseek-v4-pro:cloud'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.OLLAMA_MODELS
  })

  it('returns newest-first by Ollama release date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(TAGS)))

    const models = await fetchModels.fetchOllamaModels()
    expect(models.map(m => m.id)).toEqual([
      'kimi-k3.1-pro:cloud',
      'deepseek-v4.1-flash:cloud',
      'deepseek-v4-pro:cloud',
      'kimi-k3:cloud',
      'zeta:cloud'
    ])
    expect(models[0]).toMatchObject({
      provider: 'Ollama Cloud',
      providerId: 'ollama'
    })
  })

  it('falls back to name order when the release fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const models = await fetchModels.fetchOllamaModels()
    expect(models.map(m => m.id)).toEqual([
      'deepseek-v4-pro:cloud',
      'deepseek-v4.1-flash:cloud',
      'kimi-k3:cloud',
      'kimi-k3.1-pro:cloud',
      'zeta:cloud'
    ])
  })

  it('fetchAvailableModels keeps the release-date order for Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(TAGS)))

    const grouped = await fetchModels.fetchAvailableModels({
      forceRefresh: true
    })
    expect(grouped['Ollama Cloud']?.map(m => m.id)).toEqual([
      'kimi-k3.1-pro:cloud',
      'deepseek-v4.1-flash:cloud',
      'deepseek-v4-pro:cloud',
      'kimi-k3:cloud',
      'zeta:cloud'
    ])
  })
})
