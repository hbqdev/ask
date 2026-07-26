import { describe, expect, it } from 'vitest'

import { buildSearchTelemetryTag } from '../telemetry-tag'

// [latency:search] had no chat or turn identifier, so a search could not be
// joined to the turn that caused it. That blocked the intent-vs-crawl
// analysis outright: turns make MULTIPLE searches (measured: 5 and 7 tool
// calls on two turns of one conversation), so ordering does not give a 1:1
// mapping either, and correlating by position produced a table that looked
// plausible and was wrong.
describe('buildSearchTelemetryTag', () => {
  it('carries the chat id so a search can be joined to its turn', () => {
    expect(buildSearchTelemetryTag({ chatId: 'abc123' })).toEqual({
      chatId: 'abc123'
    })
  })

  it('omits the field entirely when there is no chat id', () => {
    // Emitting chatId:null on every line costs bytes and reads as "we tried
    // and failed" rather than "not applicable".
    expect(buildSearchTelemetryTag({})).toEqual({})
    expect(buildSearchTelemetryTag({ chatId: undefined })).toEqual({})
    expect(buildSearchTelemetryTag({ chatId: null })).toEqual({})
  })

  it('ignores a blank or whitespace-only chat id', () => {
    expect(buildSearchTelemetryTag({ chatId: '   ' })).toEqual({})
    expect(buildSearchTelemetryTag({ chatId: '' })).toEqual({})
  })

  it('rejects a non-string chat id rather than emitting junk', () => {
    expect(
      buildSearchTelemetryTag({ chatId: 42 as unknown as string })
    ).toEqual({})
  })

  it('trims surrounding whitespace so the join key is exact', () => {
    expect(buildSearchTelemetryTag({ chatId: ' abc123 ' })).toEqual({
      chatId: 'abc123'
    })
  })
})
