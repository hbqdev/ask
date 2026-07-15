import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearXNGSearchProvider } from '../searxng'

function mockSearxngResponse(results: any[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      query: 'test query',
      number_of_results: results.length,
      results
    })
  }
}

describe('SearXNGSearchProvider', () => {
  const provider = new SearXNGSearchProvider()

  beforeEach(() => {
    process.env.SEARXNG_API_URL = 'https://searxng.example.com'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SEARXNG_API_URL
  })

  it('requests only general,images categories when video content_type is not requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('bike tire', 10, 'basic', [], [], {})

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images')
  })

  it('adds the videos category when content_types includes "video"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('bike tire', 10, 'basic', [], [], {
      content_types: ['web', 'video']
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe(
      'general,images,videos'
    )
  })

  it('maps videos-category results into SerperSearchResultItem shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSearxngResponse([
        {
          title: 'How to Change a Bike Tire',
          url: 'https://www.youtube.com/watch?v=abc123',
          content: 'A tutorial on changing bike tires.',
          category: 'videos',
          thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
          length: '9:39',
          source: 'Bing',
          engine: 'youtube',
          author: 'Park Tool'
        },
        {
          title: 'A general web result',
          url: 'https://example.com/article',
          content: 'Some article content.'
        }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.search('bike tire', 10, 'basic', [], [], {
      content_types: ['video']
    })

    expect(result.videos).toHaveLength(1)
    expect(result.videos?.[0]).toEqual({
      title: 'How to Change a Bike Tire',
      link: 'https://www.youtube.com/watch?v=abc123',
      snippet: 'A tutorial on changing bike tires.',
      imageUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
      duration: '9:39',
      source: 'Bing',
      channel: 'Park Tool',
      date: '',
      position: 0
    })

    // The video result must not leak into the general results array.
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe('A general web result')
  })

  it('does not populate videos when content_types does not include "video"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSearxngResponse([
        {
          title: 'A general web result',
          url: 'https://example.com/article',
          content: 'Some article content.'
        }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.search('bike tire', 10, 'basic', [], [], {})

    expect(result.videos).toEqual([])
  })

  it('still separates image results from general results when videos are also requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSearxngResponse([
        {
          title: '',
          url: '',
          content: '',
          img_src: 'https://example.com/photo.jpg',
          category: 'images'
        },
        {
          title: 'Video result',
          url: 'https://www.youtube.com/watch?v=xyz',
          content: 'A video.',
          category: 'videos'
        },
        {
          title: 'Web result',
          url: 'https://example.com/page',
          content: 'A page.'
        }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.search('query', 10, 'basic', [], [], {
      content_types: ['video']
    })

    expect(result.images).toEqual(['https://example.com/photo.jpg'])
    expect(result.videos).toHaveLength(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe('Web result')
  })

  it('uses the academic category set regardless of content_types', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('quantum computing', 10, 'basic', [], [], {
      searchMode: 'academic',
      content_types: ['video']
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('science')
  })

  it('uses the "social media" category when searchMode is "social"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('best keyboard', 10, 'basic', [], [], {
      searchMode: 'social'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('social media')
  })

  it('adds it/map/music categories to the combined request when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('react useEffect', 10, 'basic', [], [], {
      content_types: ['it']
    })
    let calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images,it')

    await provider.search('eiffel tower', 10, 'basic', [], [], {
      content_types: ['map']
    })
    calledUrl = new URL(fetchMock.mock.calls[1][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images,map')

    await provider.search('bohemian rhapsody', 10, 'basic', [], [], {
      content_types: ['music']
    })
    calledUrl = new URL(fetchMock.mock.calls[2][0])
    expect(calledUrl.searchParams.get('categories')).toBe(
      'general,images,music'
    )
  })

  it('adds the news category when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('latest ai news', 10, 'basic', [], [], {
      content_types: ['news']
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images,news')
  })

  it('merges it/map/music/news category results into the plain results array, not a dedicated field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockSearxngResponse([
        {
          title: 'React useEffect docs',
          url: 'https://react.dev/reference/react/useEffect',
          content: 'useEffect docs.',
          category: 'it'
        },
        {
          title: 'Eiffel Tower',
          url: 'https://openstreetmap.org/way/1',
          content: 'A landmark in Paris.',
          category: 'map'
        },
        {
          title: 'Bohemian Rhapsody',
          url: 'https://soundcloud.com/queen/bohemian-rhapsody',
          content: 'A song by Queen.',
          category: 'music'
        },
        {
          title: 'AI news today',
          url: 'https://reuters.com/ai-news',
          content: 'Breaking AI news.',
          category: 'news'
        },
        {
          title: 'A general web result',
          url: 'https://example.com/article',
          content: 'Some article content.'
        }
      ])
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await provider.search('mixed query', 10, 'basic', [], [], {
      content_types: ['it', 'map', 'music', 'news']
    })

    expect(result.results).toHaveLength(5)
    expect(result.results.map(r => r.title)).toEqual([
      'A general web result',
      'React useEffect docs',
      'Eiffel Tower',
      'Bohemian Rhapsody',
      'AI news today'
    ])
    // None of these are images or videos.
    expect(result.images).toEqual([])
    expect(result.videos).toEqual([])
  })

  it('appends the intent category (code -> it) on top of general,images', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('python asyncio gather', 10, 'basic', [], [], {
      intent: 'code'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images,it')
  })

  it('adds nothing for intent=general', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('hello world', 10, 'basic', [], [], {
      intent: 'general'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('general,images')
  })

  it('does not apply intent routing in the exclusive academic branch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('quantum error correction', 10, 'basic', [], [], {
      searchMode: 'academic',
      intent: 'code'
    })

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('categories')).toBe('science')
  })

  it('embeds a single include_domains entry as a site: query operator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search('canker sore', 10, 'basic', ['reddit.com'], [], {})

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('q')).toBe('canker sore site:reddit.com')
  })

  it('embeds exclude_domains as -site: query operators, one per domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search(
      'canker sore',
      10,
      'basic',
      [],
      ['pinterest.com', 'quora.com'],
      {}
    )

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('q')).toBe(
      'canker sore -site:pinterest.com -site:quora.com'
    )
  })

  it('does not embed a site: operator when include_domains has more than one entry (unsupported by SearXNG)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    await provider.search(
      'canker sore',
      10,
      'basic',
      ['reddit.com', 'lemmy.world'],
      [],
      {}
    )

    const calledUrl = new URL(fetchMock.mock.calls[0][0])
    expect(calledUrl.searchParams.get('q')).toBe('canker sore')
  })

  describe('degoog merge', () => {
    function mockDegoogResponse(results: any[]) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ query: 'test query', results })
      }
    }

    function dispatchingFetchMock(opts: {
      searxng?: 'ok' | 'fail'
      degoog?: 'ok' | 'fail'
      searxngResults?: any[]
      degoogWebResults?: any[]
      degoogImageResults?: any[]
      degoogVideoResults?: any[]
      degoogNewsResults?: any[]
    }) {
      return vi.fn(async (url: string) => {
        if (url.includes('/api/search')) {
          if (opts.degoog === 'fail') throw new Error('degoog down')
          const type = new URL(url).searchParams.get('type')
          const resultsByType: Record<string, any[]> = {
            web: opts.degoogWebResults ?? [],
            images: opts.degoogImageResults ?? [],
            videos: opts.degoogVideoResults ?? [],
            news: opts.degoogNewsResults ?? []
          }
          return mockDegoogResponse(resultsByType[type ?? 'web'] ?? [])
        }
        if (opts.searxng === 'fail') throw new Error('searxng down')
        return mockSearxngResponse(opts.searxngResults ?? [])
      })
    }

    // degoog-client.ts keeps its circuit breaker state at module scope —
    // tests that make it fail would otherwise leak a "breaker open" state
    // into later tests in this file. Reset modules and re-import a fresh
    // provider (which re-imports a fresh degoog-client too) per test.
    async function freshProvider() {
      vi.resetModules()
      const { SearXNGSearchProvider: Fresh } = await import('../searxng')
      return new Fresh()
    }

    beforeEach(() => {
      process.env.DEGOOG_API_URL = 'https://degoog.example.com'
    })

    afterEach(() => {
      delete process.env.DEGOOG_API_URL
      delete process.env.DEGOOG_API_KEY
    })

    it('merges degoog results into the response when both succeed', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok',
        searxngResults: [
          {
            title: 'SearXNG result',
            url: 'https://searxng-only.example.com',
            content: 'From SearXNG'
          }
        ],
        degoogWebResults: [
          {
            title: 'Degoog result',
            url: 'https://degoog-only.example.com',
            snippet: 'From degoog',
            source: 'Reddit'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      const result = await freshInstance.search(
        'query',
        10,
        'basic',
        [],
        [],
        {}
      )

      // 1 SearXNG call + degoog web + degoog images (always queried,
      // mirroring SearXNG's own always-on images category) — no video/news
      // calls since content_types didn't request them.
      expect(fetchMock).toHaveBeenCalledTimes(3)
      const urls = result.results.map(r => r.url)
      expect(urls).toContain('https://searxng-only.example.com')
      expect(urls).toContain('https://degoog-only.example.com')
    })

    it('falls back to SearXNG-only results when degoog fails', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'fail',
        searxngResults: [
          {
            title: 'SearXNG result',
            url: 'https://searxng-only.example.com',
            content: 'From SearXNG'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      const result = await freshInstance.search(
        'query',
        10,
        'basic',
        [],
        [],
        {}
      )

      expect(result.results).toHaveLength(1)
      expect(result.results[0].url).toBe('https://searxng-only.example.com')
    })

    it('falls back to degoog-only results when SearXNG fails', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'fail',
        degoog: 'ok',
        degoogWebResults: [
          {
            title: 'Degoog result',
            url: 'https://degoog-only.example.com',
            snippet: 'From degoog'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      const result = await freshInstance.search(
        'query',
        10,
        'basic',
        [],
        [],
        {}
      )

      expect(result.results).toEqual([
        {
          title: 'Degoog result',
          url: 'https://degoog-only.example.com',
          content: 'From degoog'
        }
      ])
      expect(result.images).toEqual([])
      expect(result.videos).toEqual([])
    })

    it('always queries degoog images, even when content_types requests neither video nor news', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok'
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      await freshInstance.search('query', 10, 'basic', [], [], {})

      const calledTypes = fetchMock.mock.calls
        .map(call => new URL(call[0]).searchParams.get('type'))
        .filter(Boolean)
      expect(calledTypes).toContain('images')
      expect(calledTypes).not.toContain('videos')
      expect(calledTypes).not.toContain('news')
    })

    it('merges degoog image results into result.images, resolving relative degoog paths to absolute URLs', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok',
        degoogImageResults: [
          {
            title: 'A cat',
            url: 'https://example.com/cat-article',
            snippet: 'A very good cat',
            imageUrl: '/api/proxy/image?url=cat.jpg'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      const result = await freshInstance.search(
        'query',
        10,
        'basic',
        [],
        [],
        {}
      )

      expect(result.images).toContainEqual({
        url: 'https://degoog.example.com/api/proxy/image?url=cat.jpg',
        description: 'A very good cat',
        title: 'A cat',
        sourceUrl: 'https://example.com/cat-article'
      })
    })

    it('only queries degoog videos when content_types includes "video", and merges them into result.videos', async () => {
      const fetchMockWithoutVideo = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok'
      })
      vi.stubGlobal('fetch', fetchMockWithoutVideo)
      const instanceWithoutVideo = await freshProvider()
      await instanceWithoutVideo.search('query', 10, 'basic', [], [], {})
      const typesWithoutVideo = fetchMockWithoutVideo.mock.calls
        .map(call => new URL(call[0]).searchParams.get('type'))
        .filter(Boolean)
      expect(typesWithoutVideo).not.toContain('videos')

      const fetchMockWithVideo = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok',
        degoogVideoResults: [
          {
            title: 'A video',
            url: 'https://youtube.com/watch?v=abc',
            snippet: '',
            thumbnail: '/api/proxy/image?url=vid.jpg',
            duration: '1:23',
            source: 'Bing Videos'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMockWithVideo)
      const instanceWithVideo = await freshProvider()
      const result = await instanceWithVideo.search(
        'query',
        10,
        'basic',
        [],
        [],
        {
          content_types: ['video']
        }
      )

      const typesWithVideo = fetchMockWithVideo.mock.calls
        .map(call => new URL(call[0]).searchParams.get('type'))
        .filter(Boolean)
      expect(typesWithVideo).toContain('videos')
      expect(result.videos).toContainEqual({
        title: 'A video',
        link: 'https://youtube.com/watch?v=abc',
        snippet: '',
        imageUrl: 'https://degoog.example.com/api/proxy/image?url=vid.jpg',
        duration: '1:23',
        source: 'Bing Videos',
        channel: '',
        date: '',
        position: 0
      })
    })

    it('only queries degoog news when content_types includes "news", and merges them into result.results', async () => {
      const fetchMockWithoutNews = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok'
      })
      vi.stubGlobal('fetch', fetchMockWithoutNews)
      const instanceWithoutNews = await freshProvider()
      await instanceWithoutNews.search('query', 10, 'basic', [], [], {})
      const typesWithoutNews = fetchMockWithoutNews.mock.calls
        .map(call => new URL(call[0]).searchParams.get('type'))
        .filter(Boolean)
      expect(typesWithoutNews).not.toContain('news')

      const fetchMockWithNews = dispatchingFetchMock({
        searxng: 'ok',
        degoog: 'ok',
        degoogNewsResults: [
          {
            title: 'Breaking AI news from degoog',
            url: 'https://degoog-news.example.com/article',
            snippet: 'From degoog news'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMockWithNews)
      const instanceWithNews = await freshProvider()
      const result = await instanceWithNews.search(
        'query',
        10,
        'basic',
        [],
        [],
        {
          content_types: ['news']
        }
      )

      const typesWithNews = fetchMockWithNews.mock.calls
        .map(call => new URL(call[0]).searchParams.get('type'))
        .filter(Boolean)
      expect(typesWithNews).toContain('news')
      expect(result.results.map(r => r.url)).toContain(
        'https://degoog-news.example.com/article'
      )
    })

    it('includes degoog images/videos in the SearXNG-down fallback branch too', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'fail',
        degoog: 'ok',
        degoogImageResults: [
          {
            title: 'Fallback image',
            url: 'https://example.com/fallback-img-article',
            snippet: 'An image',
            imageUrl: '/api/proxy/image?url=fallback.jpg'
          }
        ],
        degoogVideoResults: [
          {
            title: 'Fallback video',
            url: 'https://youtube.com/watch?v=fallback',
            snippet: '',
            thumbnail: '/api/proxy/image?url=fallback-vid.jpg',
            duration: '2:00',
            source: 'Bing Videos'
          }
        ]
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      const result = await freshInstance.search('query', 10, 'basic', [], [], {
        content_types: ['video']
      })

      expect(result.images).toContainEqual({
        url: 'https://degoog.example.com/api/proxy/image?url=fallback.jpg',
        description: 'An image',
        title: 'Fallback image',
        sourceUrl: 'https://example.com/fallback-img-article'
      })
      expect(result.videos).toContainEqual({
        title: 'Fallback video',
        link: 'https://youtube.com/watch?v=fallback',
        snippet: '',
        imageUrl:
          'https://degoog.example.com/api/proxy/image?url=fallback-vid.jpg',
        duration: '2:00',
        source: 'Bing Videos',
        channel: '',
        date: '',
        position: 0
      })
    })

    it('throws when both SearXNG and degoog fail', async () => {
      const fetchMock = dispatchingFetchMock({
        searxng: 'fail',
        degoog: 'fail'
      })
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      await expect(
        freshInstance.search('query', 10, 'basic', [], [], {})
      ).rejects.toThrow('searxng down')
    })

    it('does not call degoog at all when DEGOOG_API_URL is not configured', async () => {
      delete process.env.DEGOOG_API_URL
      const fetchMock = vi.fn().mockResolvedValue(mockSearxngResponse([]))
      vi.stubGlobal('fetch', fetchMock)
      const freshInstance = await freshProvider()

      await freshInstance.search('query', 10, 'basic', [], [], {})

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
