import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getGeneralSearchProviderName,
  getGeneralSearchProviderType,
  isGeneralSearchProviderAvailable,
  supportsMultimediaContentTypes
} from '../search-config'

describe('search-config', () => {
  beforeEach(() => {
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.SEARXNG_API_URL
  })

  afterEach(() => {
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.SEARXNG_API_URL
  })

  describe('isGeneralSearchProviderAvailable', () => {
    it('is false when neither Brave nor SearXNG is configured', () => {
      expect(isGeneralSearchProviderAvailable()).toBe(false)
    })

    it('is true when only SearXNG is configured', () => {
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(isGeneralSearchProviderAvailable()).toBe(true)
    })

    it('is true when only Brave is configured', () => {
      process.env.BRAVE_SEARCH_API_KEY = 'key'
      expect(isGeneralSearchProviderAvailable()).toBe(true)
    })
  })

  describe('supportsMultimediaContentTypes', () => {
    it('is true when SearXNG is configured (it supports the videos category)', () => {
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(supportsMultimediaContentTypes()).toBe(true)
    })

    it('is false when nothing is configured', () => {
      expect(supportsMultimediaContentTypes()).toBe(false)
    })
  })

  describe('getGeneralSearchProviderName', () => {
    it('returns "SearXNG" when only SearXNG is configured', () => {
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(getGeneralSearchProviderName()).toBe('SearXNG')
    })

    it('prefers Brave Search when both are configured', () => {
      process.env.BRAVE_SEARCH_API_KEY = 'key'
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(getGeneralSearchProviderName()).toBe('Brave Search')
    })

    it('falls back to "primary provider" when neither is configured', () => {
      expect(getGeneralSearchProviderName()).toBe('primary provider')
    })
  })

  describe('getGeneralSearchProviderType', () => {
    it('returns "searxng" when only SearXNG is configured', () => {
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(getGeneralSearchProviderType()).toBe('searxng')
    })

    it('returns "brave" when Brave is configured, even alongside SearXNG', () => {
      process.env.BRAVE_SEARCH_API_KEY = 'key'
      process.env.SEARXNG_API_URL = 'https://searxng.example.com'
      expect(getGeneralSearchProviderType()).toBe('brave')
    })

    it('returns null when neither is configured', () => {
      expect(getGeneralSearchProviderType()).toBe(null)
    })
  })
})
