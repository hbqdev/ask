import { describe, expect, it } from 'vitest'

import {
  parseLangSearchResponse,
  toLangSearchFreshness
} from '../langsearch-client'

// Envelope verified against the live API 2026-07-27. Two things about it are
// unusual enough to pin: the status lives in the BODY (a call returned HTTP 200
// with body code 500 during testing), and `id` is a per-response ordinal, not a
// document id.
function envelope(items: unknown[], code = 200, msg: string | null = null) {
  return {
    code,
    log_id: 'abc123',
    msg,
    data: {
      _type: 'SearchResponse',
      webPages: { value: items, someResultsRemoved: true }
    }
  }
}

const ITEM = {
  id: 'https://api.langsearch.com/v1/web-search#1',
  name: 'DDL Replication',
  url: 'https://wiki.postgresql.org/x.pdf',
  displayUrl: 'https://wiki.postgresql.org/x.pdf',
  snippet: 'short snippet',
  summary: 'long summary text',
  datePublished: null,
  dateLastCrawled: null
}

describe('parseLangSearchResponse', () => {
  it('reads results from data.webPages.value', () => {
    expect(parseLangSearchResponse(envelope([ITEM]))).toEqual([
      {
        title: 'DDL Replication',
        url: 'https://wiki.postgresql.org/x.pdf',
        content: 'long summary text'
      }
    ])
  })

  it('throws on a non-200 BODY code even when HTTP was fine', () => {
    // The live API returned HTTP 200 with body {"code":500}. Trusting
    // response.ok alone would parse a failure as "no results", which reads as
    // a working-but-unhelpful source instead of an outage.
    expect(() =>
      parseLangSearchResponse(envelope([], 500, 'server error'))
    ).toThrow(/body code 500/)
  })

  it('prefers summary over snippet, falling back when summary is absent', () => {
    const [withSummary] = parseLangSearchResponse(envelope([ITEM]))
    expect(withSummary.content).toBe('long summary text')
    const [noSummary] = parseLangSearchResponse(
      envelope([{ ...ITEM, summary: undefined }])
    )
    expect(noSummary.content).toBe('short snippet')
  })

  it('bounds the content — summary runs to ~18k chars in practice', () => {
    const huge = 'x'.repeat(50_000)
    const [r] = parseLangSearchResponse(envelope([{ ...ITEM, summary: huge }]))
    expect(r.content.length).toBe(2_000)
  })

  it('dedups on url, NOT on id', () => {
    // `id` is "…/web-search#N", an ordinal within this response, so two
    // distinct ids can be the same document.
    const a = { ...ITEM, id: '…#1' }
    const b = { ...ITEM, id: '…#2' }
    expect(parseLangSearchResponse(envelope([a, b]))).toHaveLength(1)
  })

  it('drops items with no url and survives a missing results block', () => {
    expect(
      parseLangSearchResponse(envelope([{ ...ITEM, url: undefined }]))
    ).toEqual([])
    expect(parseLangSearchResponse({ code: 200, data: {} })).toEqual([])
    expect(parseLangSearchResponse({})).toEqual([])
  })

  it('tolerates missing title', () => {
    const [r] = parseLangSearchResponse(
      envelope([{ ...ITEM, name: undefined }])
    )
    expect(r.title).toBe('')
  })
})

describe('toLangSearchFreshness', () => {
  it('maps the turn recency signal onto LangSearch native freshness', () => {
    // The classifier already decides recency; LangSearch supports it natively,
    // so it is passed through rather than being reimplemented downstream.
    expect(toLangSearchFreshness('day')).toBe('oneDay')
    expect(toLangSearchFreshness('week')).toBe('oneWeek')
    expect(toLangSearchFreshness('month')).toBe('oneMonth')
    expect(toLangSearchFreshness('year')).toBe('oneYear')
  })

  it('defaults to noLimit when the turn is not recency-sensitive', () => {
    expect(toLangSearchFreshness(undefined)).toBe('noLimit')
  })
})
