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
})
