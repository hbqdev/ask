import { describe, expect, it } from 'vitest'

import {
  countSearchPayload,
  routeEmitsSearchTelemetry
} from '../basic-telemetry'

// The basic search path emitted no telemetry at all. Only the first search of
// a turn goes through /api/advanced-search; expansion variants and every
// follow-up tier down to basic and called the provider directly, so on a
// 17-tool-call turn roughly 90% of the searches produced no timing line.
describe('routeEmitsSearchTelemetry', () => {
  it('claims the searxng advanced search, which self-reports from the route', () => {
    // Emitting here too would double-count that search in every average.
    expect(routeEmitsSearchTelemetry('searxng', 'advanced')).toBe(true)
  })

  it('leaves searxng basic to the tool — this is the gap being closed', () => {
    expect(routeEmitsSearchTelemetry('searxng', 'basic')).toBe(false)
  })

  it('leaves non-searxng providers to the tool at BOTH depths', () => {
    // Depth alone is not the discriminator: brave/tavily/exa never reach
    // /api/advanced-search, so an advanced-depth search on those providers is
    // still the tool's to report. Keying only on depth would have silently
    // dropped every advanced non-searxng search.
    for (const provider of ['brave', 'tavily', 'exa'] as const) {
      expect(routeEmitsSearchTelemetry(provider, 'advanced')).toBe(false)
      expect(routeEmitsSearchTelemetry(provider, 'basic')).toBe(false)
    }
  })
})

describe('countSearchPayload', () => {
  it('counts each result array', () => {
    expect(
      countSearchPayload({
        results: [1, 2, 3],
        images: [1, 2],
        videos: [1]
      })
    ).toEqual({ returned: 3, images: 2, videos: 1 })
  })

  it('reads a missing array as zero rather than throwing', () => {
    // Providers disagree about which fields they populate — Brave returns
    // videos, SearXNG only when asked, Tavily never. Telemetry must never be
    // the thing that breaks the turn it is measuring.
    expect(countSearchPayload({ results: [1] })).toEqual({
      returned: 1,
      images: 0,
      videos: 0
    })
    expect(countSearchPayload({})).toEqual({
      returned: 0,
      images: 0,
      videos: 0
    })
  })

  it('survives a null or undefined result', () => {
    const zero = { returned: 0, images: 0, videos: 0 }
    expect(countSearchPayload(null)).toEqual(zero)
    expect(countSearchPayload(undefined)).toEqual(zero)
  })

  it('ignores a non-array field instead of trusting its length', () => {
    // A cached payload reshaped by a bad round trip should read as 0, not
    // produce a nonsense count from a string's length.
    expect(
      countSearchPayload({
        results: 'not an array' as unknown as unknown[]
      })
    ).toEqual({ returned: 0, images: 0, videos: 0 })
  })
})
