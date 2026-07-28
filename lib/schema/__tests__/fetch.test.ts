import { describe, expect, it } from 'vitest'

import {
  FETCH_MAX_URLS,
  fetchSchema,
  normalizeFetchUrls,
  primaryFetchUrl
} from '../fetch'

// fetch took one url per call, so N pages meant N tool calls — and each tool
// call is a full model round trip (call → wait → read → decide). Measured turns
// spent 80.1s inside fetch across just 3 calls. Batching removes the round
// trips; the pages themselves run concurrently.

describe('normalizeFetchUrls', () => {
  it('accepts a bare string — the pre-batching shape', () => {
    // Persisted messages and single-page calls still send this.
    expect(normalizeFetchUrls('https://a.com')).toEqual(['https://a.com'])
  })

  it('accepts an array', () => {
    expect(normalizeFetchUrls(['https://a.com', 'https://b.com'])).toEqual([
      'https://a.com',
      'https://b.com'
    ])
  })

  it('dedups, so a repeated url is not fetched twice in one batch', () => {
    expect(
      normalizeFetchUrls(['https://a.com', 'https://a.com', 'https://b.com'])
    ).toEqual(['https://a.com', 'https://b.com'])
  })

  it('caps the batch', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://s${i}.com`)
    expect(normalizeFetchUrls(many)).toHaveLength(FETCH_MAX_URLS)
  })

  it('drops junk entries rather than failing the whole call', () => {
    // One malformed url in a batch must cost that entry, not the others.
    expect(
      normalizeFetchUrls([
        'https://a.com',
        '',
        '   ',
        null as unknown as string,
        42 as unknown as string,
        'https://b.com'
      ])
    ).toEqual(['https://a.com', 'https://b.com'])
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeFetchUrls(['  https://a.com  '])).toEqual(['https://a.com'])
  })

  it('returns empty for input with nothing usable', () => {
    expect(normalizeFetchUrls([])).toEqual([])
    expect(normalizeFetchUrls('')).toEqual([])
  })
})

describe('primaryFetchUrl', () => {
  it('gives the UI a single url for title and open-in-tab', () => {
    expect(primaryFetchUrl('https://a.com')).toBe('https://a.com')
    expect(primaryFetchUrl(['https://a.com', 'https://b.com'])).toBe(
      'https://a.com'
    )
  })

  it('is undefined when there is nothing to show', () => {
    expect(primaryFetchUrl(undefined)).toBeUndefined()
    expect(primaryFetchUrl([])).toBeUndefined()
  })
})

describe('fetchSchema', () => {
  it('parses both a string and an array of urls', () => {
    expect(fetchSchema.parse({ url: 'https://a.com' }).url).toBe(
      'https://a.com'
    )
    expect(
      fetchSchema.parse({ url: ['https://a.com', 'https://b.com'] }).url
    ).toEqual(['https://a.com', 'https://b.com'])
  })

  it('still defaults type, so existing callers are unchanged', () => {
    expect(fetchSchema.parse({ url: 'https://a.com' }).type).toBe('regular')
  })
})
