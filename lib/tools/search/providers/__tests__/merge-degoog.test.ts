import { describe, expect, it } from 'vitest'

import type {
  DegoogResult,
  SearchResultImage,
  SearchResultItem,
  SerperSearchResultItem
} from '@/lib/types'

import {
  mergeImagesWithDegoog,
  mergeVideosWithDegoog,
  mergeWithDegoogResults,
  resolveDegoogUrl,
  toSearchResultImage,
  toSearchResultItem,
  toSerperVideoItem
} from '../merge-degoog'

const DEGOOG_BASE_URL = 'https://nogoog.example.com'

function searxngItem(url: string, title = url): SearchResultItem {
  return { title, url, content: `content for ${title}` }
}

function degoogResult(
  url: string,
  overrides: Partial<DegoogResult> = {}
): DegoogResult {
  return {
    title: overrides.title ?? url,
    url,
    snippet: `snippet for ${url}`,
    ...overrides
  }
}

describe('mergeWithDegoogResults', () => {
  it('dedupes an exact-duplicate URL appearing in both lists', () => {
    const merged = mergeWithDegoogResults(
      [
        searxngItem('https://example.com/a'),
        searxngItem('https://example.com/b')
      ],
      [
        degoogResult('https://example.com/a'),
        degoogResult('https://example.com/c')
      ],
      10
    )

    const urls = merged.map(r => r.url)
    expect(urls.filter(u => u === 'https://example.com/a')).toHaveLength(1)
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c'
      ])
    )
  })

  it('treats http/https and www./no-www as the same URL for dedup', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('http://www.example.com/page/')],
      [degoogResult('https://example.com/page')],
      10
    )

    expect(merged).toHaveLength(1)
  })

  it('does NOT collapse distinct pages that differ only by a real query param', () => {
    // A naive host+path-only normalization would wrongly merge these.
    const merged = mergeWithDegoogResults(
      [searxngItem('https://youtube.com/watch?v=abc')],
      [degoogResult('https://youtube.com/watch?v=xyz')],
      10
    )

    expect(merged).toHaveLength(2)
    expect(merged.map(r => r.url)).toEqual(
      expect.arrayContaining([
        'https://youtube.com/watch?v=abc',
        'https://youtube.com/watch?v=xyz'
      ])
    )
  })

  it('ignores tracking params when deduping', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://example.com/article?utm_source=newsletter')],
      [
        degoogResult(
          'https://example.com/article?utm_source=twitter&utm_medium=social'
        )
      ],
      10
    )

    expect(merged).toHaveLength(1)
  })

  it('interleaves rank order, draining the longer list once the shorter is exhausted', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [
        degoogResult('https://d1.com'),
        degoogResult('https://d2.com'),
        degoogResult('https://d3.com'),
        degoogResult('https://d4.com')
      ],
      10
    )

    expect(merged.map(r => r.url)).toEqual([
      'https://s1.com',
      'https://d1.com',
      'https://s2.com',
      'https://d2.com',
      'https://d3.com',
      'https://d4.com'
    ])
  })

  it('promotes niche-source degoog results ahead of mainstream duplicates so they survive truncation', () => {
    // 4 mainstream SearXNG results fill maxResults before degoog's niche
    // result would ever get an interleaved slot under strict alternation.
    const searxngResults = [
      searxngItem('https://mainstream1.com'),
      searxngItem('https://mainstream2.com'),
      searxngItem('https://mainstream3.com'),
      searxngItem('https://mainstream4.com')
    ]
    const degoogResults = [
      degoogResult('https://reddit.com/r/thread', { source: 'Reddit' }),
      degoogResult('https://mainstream5.com', { source: 'Brave Search' })
    ]

    const merged = mergeWithDegoogResults(searxngResults, degoogResults, 3)

    expect(merged.map(r => r.url)).toContain('https://reddit.com/r/thread')
  })

  it('matches niche sources via the sources[] array too, not just source', () => {
    const merged = mergeWithDegoogResults(
      [
        searxngItem('https://m1.com'),
        searxngItem('https://m2.com'),
        searxngItem('https://m3.com')
      ],
      [
        degoogResult('https://news.ycombinator.com/item?id=1', {
          source: 'Brave Search',
          sources: ['Brave Search', 'Hacker News']
        })
      ],
      2
    )

    expect(merged.map(r => r.url)).toContain(
      'https://news.ycombinator.com/item?id=1'
    )
  })

  it('slices to maxResults after merging', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [degoogResult('https://d1.com'), degoogResult('https://d2.com')],
      2
    )

    expect(merged).toHaveLength(2)
  })

  it('handles an empty degoog list (falls back to SearXNG order untouched)', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [],
      10
    )

    expect(merged.map(r => r.url)).toEqual(['https://s1.com', 'https://s2.com'])
  })
})

describe('toSearchResultItem', () => {
  it('maps a degoog result into the shared SearchResultItem shape', () => {
    const item = toSearchResultItem(
      degoogResult('https://example.com', {
        title: 'Example',
        snippet: 'An example snippet'
      })
    )

    expect(item).toEqual({
      title: 'Example',
      url: 'https://example.com',
      content: 'An example snippet'
    })
  })
})

describe('resolveDegoogUrl', () => {
  it('leaves an already-absolute URL untouched', () => {
    expect(
      resolveDegoogUrl('https://cdn.example.com/img.jpg', DEGOOG_BASE_URL)
    ).toBe('https://cdn.example.com/img.jpg')
  })

  it('resolves a degoog-relative proxy path against the base URL', () => {
    expect(
      resolveDegoogUrl(
        '/api/proxy/image?url=https%3A%2F%2Fexample.com%2Fimg.jpg',
        DEGOOG_BASE_URL
      )
    ).toBe(
      `${DEGOOG_BASE_URL}/api/proxy/image?url=https%3A%2F%2Fexample.com%2Fimg.jpg`
    )
  })

  it('returns an empty path unchanged', () => {
    expect(resolveDegoogUrl('', DEGOOG_BASE_URL)).toBe('')
  })
})

describe('toSearchResultImage', () => {
  it('maps a degoog image result, resolving imageUrl against the base URL', () => {
    const image = toSearchResultImage(
      degoogResult('https://example.com/article', {
        title: 'A cat',
        snippet: 'A very good cat',
        imageUrl: '/api/proxy/image?url=cat.jpg',
        thumbnail: '/api/proxy/image?url=cat-thumb.jpg'
      }),
      DEGOOG_BASE_URL
    )

    expect(image).toEqual({
      url: `${DEGOOG_BASE_URL}/api/proxy/image?url=cat.jpg`,
      description: 'A very good cat',
      title: 'A cat',
      sourceUrl: 'https://example.com/article'
    })
  })

  it('falls back to thumbnail when imageUrl is absent', () => {
    const image = toSearchResultImage(
      degoogResult('https://example.com/article', {
        thumbnail: '/api/proxy/image?url=thumb-only.jpg'
      }),
      DEGOOG_BASE_URL
    )

    expect(image).toMatchObject({
      url: `${DEGOOG_BASE_URL}/api/proxy/image?url=thumb-only.jpg`
    })
  })
})

describe('toSerperVideoItem', () => {
  it('maps a degoog video result into the Serper video shape', () => {
    const video = toSerperVideoItem(
      degoogResult('https://youtube.com/watch?v=abc', {
        title: 'A video',
        snippet: 'Description',
        thumbnail: '/api/proxy/image?url=vid-thumb.jpg',
        duration: '1:23',
        source: 'Bing Videos'
      }),
      DEGOOG_BASE_URL
    )

    expect(video).toEqual({
      title: 'A video',
      link: 'https://youtube.com/watch?v=abc',
      snippet: 'Description',
      imageUrl: `${DEGOOG_BASE_URL}/api/proxy/image?url=vid-thumb.jpg`,
      duration: '1:23',
      source: 'Bing Videos',
      channel: '',
      date: '',
      position: 0
    })
  })
})

function searxngImage(url: string): SearchResultImage {
  return url
}

describe('mergeImagesWithDegoog', () => {
  it('dedupes an exact-duplicate resolved image URL appearing in both lists', () => {
    const merged = mergeImagesWithDegoog(
      [searxngImage('https://cdn.example.com/a.jpg')],
      [
        degoogResult('https://example.com/page-a', {
          imageUrl: 'https://cdn.example.com/a.jpg'
        }),
        degoogResult('https://example.com/page-b', {
          imageUrl: '/api/proxy/image?url=b.jpg'
        })
      ],
      10,
      DEGOOG_BASE_URL
    )

    const urls = merged.map(img => (typeof img === 'string' ? img : img.url))
    expect(
      urls.filter(u => u === 'https://cdn.example.com/a.jpg')
    ).toHaveLength(1)
    expect(urls).toContain(`${DEGOOG_BASE_URL}/api/proxy/image?url=b.jpg`)
  })

  it('promotes niche-source (e.g. Wikimedia Commons) images ahead of mainstream duplicates', () => {
    const searxngImages = [
      searxngImage('https://m1.com/1.jpg'),
      searxngImage('https://m2.com/2.jpg'),
      searxngImage('https://m3.com/3.jpg')
    ]
    const degoogResults = [
      degoogResult('https://commons.wikimedia.org/wiki/File:x', {
        source: 'Wikimedia Commons',
        imageUrl: '/api/proxy/image?url=commons.jpg'
      })
    ]

    const merged = mergeImagesWithDegoog(
      searxngImages,
      degoogResults,
      2,
      DEGOOG_BASE_URL
    )

    const urls = merged.map(img => (typeof img === 'string' ? img : img.url))
    expect(urls).toContain(`${DEGOOG_BASE_URL}/api/proxy/image?url=commons.jpg`)
  })

  it('slices to maxResults after merging', () => {
    const merged = mergeImagesWithDegoog(
      [searxngImage('https://s1.com/1.jpg')],
      [
        degoogResult('https://d1.com', { imageUrl: 'https://d1.com/1.jpg' }),
        degoogResult('https://d2.com', { imageUrl: 'https://d2.com/2.jpg' })
      ],
      2,
      DEGOOG_BASE_URL
    )

    expect(merged).toHaveLength(2)
  })
})

function serperVideo(link: string): SerperSearchResultItem {
  return {
    title: link,
    link,
    snippet: '',
    imageUrl: '',
    duration: '',
    source: '',
    channel: '',
    date: '',
    position: 0
  }
}

describe('mergeVideosWithDegoog', () => {
  it('dedupes an exact-duplicate video URL appearing in both lists', () => {
    const merged = mergeVideosWithDegoog(
      [serperVideo('https://youtube.com/watch?v=abc')],
      [
        degoogResult('https://youtube.com/watch?v=abc', {
          source: 'Bing Videos'
        })
      ],
      10,
      DEGOOG_BASE_URL
    )

    expect(merged).toHaveLength(1)
  })

  it('adds a distinct degoog video not present in the SearXNG list', () => {
    const merged = mergeVideosWithDegoog(
      [serperVideo('https://youtube.com/watch?v=abc')],
      [
        degoogResult('https://youtube.com/watch?v=xyz', {
          source: 'Google Videos'
        })
      ],
      10,
      DEGOOG_BASE_URL
    )

    expect(merged.map(v => v.link)).toEqual(
      expect.arrayContaining([
        'https://youtube.com/watch?v=abc',
        'https://youtube.com/watch?v=xyz'
      ])
    )
  })
})
