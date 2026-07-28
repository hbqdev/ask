import { describe, expect, it } from 'vitest'

import { isRetryableFetchError } from '../fetch'

// The fetch rescue chain is SERIAL: plain fetch -> Crawl4AI -> FlareSolverr ->
// Tavily extract -> Firecrawl. Every second spent retrying tier 1 postpones the
// browser-based tiers that are the ones able to rescue a JS-rendered or
// bot-walled page. Retrying a definitive status is therefore doubly wasteful.
describe('isRetryableFetchError', () => {
  it('does not retry a definitive client decision', () => {
    // The server has answered; it will answer the same way in 500ms.
    // NOTE 403 is deliberately absent — see the next case.
    for (const status of [400, 401, 404, 410, 451]) {
      expect(isRetryableFetchError(new Error(`HTTP ${status}: Nope`))).toBe(
        false
      )
    }
  })

  it('DOES retry 403 — it is measured flakiness here, not a decision', () => {
    // verywellhealth.com, health.com and goodrx.com intermittently 403 a plain
    // fetch and succeed on a bare retry seconds later. Classifying 403 as
    // final regressed that recovery and was caught by fetch.test.ts.
    expect(isRetryableFetchError(new Error('HTTP 403: Forbidden'))).toBe(true)
  })

  it('DOES retry the two statuses that explicitly mean "later"', () => {
    expect(
      isRetryableFetchError(new Error('HTTP 429: Too Many Requests'))
    ).toBe(true)
    expect(isRetryableFetchError(new Error('HTTP 408: Request Timeout'))).toBe(
      true
    )
  })

  it('retries server-side failures', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableFetchError(new Error(`HTTP ${status}: Bad`))).toBe(true)
    }
  })

  it('retries non-HTTP failures — this is the flakiness the retry exists for', () => {
    // Timeouts, DNS, connection resets: the original reason for retrying, and
    // the case where a second attempt genuinely succeeds.
    expect(isRetryableFetchError(new Error('The operation was aborted'))).toBe(
      true
    )
    expect(isRetryableFetchError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableFetchError('not even an Error')).toBe(true)
  })

  it('only matches a status at the start, not one mentioned in prose', () => {
    // "…returned HTTP 404 in the body" is not a 404 response.
    expect(
      isRetryableFetchError(new Error('page said HTTP 404: not found'))
    ).toBe(true)
  })
})
