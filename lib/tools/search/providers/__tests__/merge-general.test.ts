import { describe, expect, it } from 'vitest'

import type { SearchResults } from '@/lib/types'

import { mergeGeneralSearchResults } from '../merge-general'

const shell = (over: Partial<SearchResults> = {}): SearchResults => ({
  results: [],
  images: [],
  videos: [],
  query: 'q',
  number_of_results: 0,
  ...over
})

describe('mergeGeneralSearchResults', () => {
  it('puts Brave results first, appends unique SearXNG URLs, dedupes collisions', () => {
    const merged = mergeGeneralSearchResults(
      shell({
        results: [{ title: 'b1', url: 'https://a.com', content: 'brave a' }]
      }),
      shell({
        results: [
          { title: 's1', url: 'https://a.com/', content: 'searxng a' },
          { title: 's2', url: 'https://b.com', content: 'searxng b' }
        ]
      }),
      'q'
    )
    expect(merged.results.map(r => r.url)).toEqual([
      'https://a.com',
      'https://b.com'
    ])
    // Brave wins the URL collision.
    expect(merged.results[0].content).toBe('brave a')
    expect(merged.number_of_results).toBe(2)
  })

  it('normalizes Brave `description` into `content`', () => {
    const merged = mergeGeneralSearchResults(
      shell({
        results: [
          { title: 'b', url: 'https://a.com', description: 'snippet' } as never
        ]
      }),
      null,
      'q'
    )
    expect(merged.results[0].content).toBe('snippet')
  })

  it('degrades to SearXNG alone when Brave is null (failed or credits out)', () => {
    const merged = mergeGeneralSearchResults(
      null,
      shell({
        results: [{ title: 's', url: 'https://s.com', content: 'c' }],
        images: ['https://img.example/1.jpg'],
        query: 'searxng-q'
      }),
      'fallback-q'
    )
    expect(merged.results).toHaveLength(1)
    expect(merged.images).toEqual(['https://img.example/1.jpg'])
    expect(merged.query).toBe('searxng-q')
  })

  it('prefers Brave images/videos but falls back to SearXNG when Brave has none', () => {
    const braveVideos = [
      {
        title: 'v',
        link: 'https://v.com',
        snippet: '',
        imageUrl: '',
        duration: '',
        source: '',
        channel: '',
        date: '',
        position: 0
      }
    ]
    const withBrave = mergeGeneralSearchResults(
      shell({ videos: braveVideos, images: [] }),
      shell({ images: ['https://s.img/1.jpg'] }),
      'q'
    )
    expect(withBrave.videos).toEqual(braveVideos)
    expect(withBrave.images).toEqual(['https://s.img/1.jpg'])
  })

  it('returns an empty shell when both sides are null', () => {
    const merged = mergeGeneralSearchResults(null, null, 'the-query')
    expect(merged.results).toEqual([])
    expect(merged.query).toBe('the-query')
  })
})
