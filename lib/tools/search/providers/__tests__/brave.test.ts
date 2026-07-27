import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type BraveBudgetHooks, BraveSearchProvider } from '../brave'

// Budget hooks are injected so these tests need no Redis. The real default
// fails CLOSED without one, which is correct for a metered API but would make
// every case below a no-op.
function fakeBudget(allowed = true) {
  const recorded: number[] = []
  const hooks: BraveBudgetHooks = {
    check: async () => ({ allowed, used: 0, budget: 1000 }),
    record: async (n: number) => {
      recorded.push(n)
    }
  }
  return { hooks, recorded }
}

// Brave's news endpoint went unhandled: the provider covered only
// web/video/image, while the agent prompt explicitly directs
// "Today's news, current events: content_types: ['news']". That request
// produced ZERO Brave results with no error and fell back to SearXNG alone —
// whose news engines are the ones CAPTCHA-blocked on our VPN egress.

// Shape verified against a live /res/v1/news/search response 2026-07-27.
function newsResponse(items: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ type: 'news', query: {}, results: items })
  }
}

function webResponse(items: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ web: { results: items } })
  }
}

const NEWS_ITEM = {
  type: 'news_result',
  title: 'Chip controls tighten',
  url: 'https://example.com/chips',
  description: 'New rules land this week.',
  age: '2 days ago',
  page_age: '2026-07-25T00:00:00'
}

describe('BraveSearchProvider — news', () => {
  beforeEach(() => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
    process.env.BRAVE_MONTHLY_BUDGET = '1000'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_MONTHLY_BUDGET
  })

  it('calls the news endpoint for content_types ["news"]', async () => {
    const fetchMock = vi.fn().mockResolvedValue(newsResponse([NEWS_ITEM]))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    await provider.search('chip controls', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })

    const urls = fetchMock.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/res/v1/news/search'))).toBe(true)
    // Must NOT silently fall back to the web endpoint.
    expect(urls.some(u => u.includes('/res/v1/web/search'))).toBe(false)
  })

  it('maps news items into results with description (merge-general reads it as content)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(newsResponse([NEWS_ITEM])))

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('chip controls', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })

    expect(out.results).toHaveLength(1)
    expect(out.results[0]).toMatchObject({
      title: 'Chip controls tighten',
      url: 'https://example.com/chips'
    })
    // merge-general.ts normalizes `description` -> `content`; emitting
    // `content` here instead would render empty snippets.
    expect(
      (out.results[0] as unknown as { description: string }).description
    ).toBe('New rules land this week.')
    expect(out.number_of_results).toBe(1)
  })

  it('drops news items with no url — the merge dedups on url and they cannot be cited', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          newsResponse([NEWS_ITEM, { title: 'no url', description: 'x' }])
        )
    )

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('q', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })
    expect(out.results).toHaveLength(1)
  })

  it('tolerates missing optional fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(newsResponse([{ url: 'https://example.com/bare' }]))
    )

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('q', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })
    expect(out.results[0]).toMatchObject({
      title: 'No title',
      url: 'https://example.com/bare'
    })
  })

  it('puts news AHEAD of web without either clobbering the other', async () => {
    // searchWeb ASSIGNS results.results; a news handler that also assigned
    // would race it under Promise.all and one side would vanish.
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('/news/')
          ? newsResponse([NEWS_ITEM])
          : webResponse([
              {
                title: 'Background piece',
                url: 'https://example.com/bg',
                description: 'older context'
              }
            ])
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('q', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['web', 'news']
    })

    expect(out.results.map(r => r.url)).toEqual([
      'https://example.com/chips',
      'https://example.com/bg'
    ])
  })

  it('clamps count to 20 — Brave rejects more, and the error was being swallowed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(newsResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    await provider.search('q', 50, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('count=20')
  })

  it('makes no API call at all for content types Brave does not serve', async () => {
    // e.g. content_types: ['it'] — must not burn budget on a call that cannot
    // return anything.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('q', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['it'] as unknown as ['web']
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.results).toEqual([])
  })

  it('does not bill a failed news call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({})
      })
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const provider = new BraveSearchProvider(fakeBudget().hooks)
    const out = await provider.search('q', 10, 'basic', [], [], {
      type: 'general',
      content_types: ['news']
    })
    // Degrades to empty rather than throwing — merge-general handles an empty
    // Brave half, so the search still returns SearXNG's results.
    expect(out.results).toEqual([])
  })
})
