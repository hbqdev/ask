import { describe, expect, it } from 'vitest'

import { resolveSearchSettings } from '../request-search-settings'

describe('resolveSearchSettings', () => {
  it('uses body searchMode "quality" over cookie "speed"', () => {
    expect(
      resolveSearchSettings({
        bodySearchMode: 'quality',
        cookieSearchMode: 'speed'
      }).searchMode
    ).toBe('quality')
  })

  it('maps legacy cookie "quick" to speed and "adaptive" to balanced', () => {
    expect(
      resolveSearchSettings({ cookieSearchMode: 'quick' }).searchMode
    ).toBe('speed')
    expect(
      resolveSearchSettings({ cookieSearchMode: 'adaptive' }).searchMode
    ).toBe('balanced')
  })

  it('uses a valid cookie searchMode when the body omits it', () => {
    expect(
      resolveSearchSettings({ cookieSearchMode: 'quality' }).searchMode
    ).toBe('quality')
  })

  it('falls back to balanced for an unknown cookie searchMode', () => {
    expect(
      resolveSearchSettings({ cookieSearchMode: 'turbo' }).searchMode
    ).toBe('balanced')
  })

  it('defaults to balanced and ["web"]', () => {
    expect(resolveSearchSettings({})).toEqual({
      searchMode: 'balanced',
      sources: ['web']
    })
  })

  it('uses body sources ["web","academic"]', () => {
    expect(
      resolveSearchSettings({
        bodySources: ['web', 'academic'],
        cookieSources: '["social"]'
      }).sources
    ).toEqual(['web', 'academic'])
  })

  it('deduplicates body sources', () => {
    expect(
      resolveSearchSettings({ bodySources: ['web', 'web', 'social'] }).sources
    ).toEqual(['web', 'social'])
  })

  describe('ignores invalid body sources and keeps the cookie value', () => {
    it.each([
      ['[]', []],
      ['["web","x"]', ['web', 'x']],
      ['"web"', 'web'],
      ['null', null]
    ])('%s', (_label, bodySources) => {
      expect(
        resolveSearchSettings({ bodySources, cookieSources: '["social"]' })
          .sources
      ).toEqual(['social'])
      expect(resolveSearchSettings({ bodySources }).sources).toEqual(['web'])
    })
  })

  it('ignores an invalid body searchMode "turbo"', () => {
    expect(
      resolveSearchSettings({
        bodySearchMode: 'turbo',
        cookieSearchMode: 'speed'
      }).searchMode
    ).toBe('speed')
    expect(resolveSearchSettings({ bodySearchMode: 'turbo' }).searchMode).toBe(
      'balanced'
    )
  })

  it('does not apply legacy mapping to body searchMode', () => {
    expect(
      resolveSearchSettings({
        bodySearchMode: 'quick',
        cookieSearchMode: 'quality'
      }).searchMode
    ).toBe('quality')
  })

  it('parses cookie sources \'["social"]\'', () => {
    expect(
      resolveSearchSettings({ cookieSources: '["social"]' }).sources
    ).toEqual(['social'])
  })

  it('falls back to ["web"] on malformed cookie JSON', () => {
    expect(resolveSearchSettings({ cookieSources: '[web' }).sources).toEqual([
      'web'
    ])
  })

  it('falls back to ["web"] on an empty cookie array', () => {
    expect(resolveSearchSettings({ cookieSources: '[]' }).sources).toEqual([
      'web'
    ])
  })
})
