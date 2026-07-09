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
})
