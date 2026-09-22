import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { groupRecentChats, type RecentChat } from '../recent-chats-section'
import {
  applyOptimisticRecent,
  pruneReconciledOverrides
} from '../recent-optimistic'
import { formatDateWithTime, toDate, toEpochMs } from '../recent-time'

// Run as a viewer in Pacific time (PDT in September, UTC-7) — the zone the
// "sidebar shows UTC" report came from. Node re-reads process.env.TZ live.
const ORIGINAL_TZ = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles'
})
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ
})

// A chat created at 12:24 PM PDT is stored in the `timestamp without time
// zone` column as the UTC wall clock 19:24.
const NAIVE_UTC = '2026-09-22 19:24:07.99'
const INSTANT = Date.UTC(2026, 8, 22, 19, 24, 7, 990)

describe('toEpochMs / toDate', () => {
  test('sanity: the test really runs in PDT', () => {
    expect(new Date(INSTANT).getTimezoneOffset()).toBe(7 * 60)
  })

  test('reads a naive DB timestamp string as UTC, not viewer-local', () => {
    expect(toEpochMs(NAIVE_UTC)).toBe(INSTANT)
    expect(toEpochMs('2026-09-22T19:24:07.99')).toBe(INSTANT)
    // What a bare `new Date()` would do — 7h in the future for PDT.
    expect(new Date(NAIVE_UTC).getTime()).toBe(INSTANT + 7 * 3600_000)
  })

  test('leaves offset-bearing strings, Dates and numbers alone', () => {
    expect(toEpochMs('2026-09-22T19:24:07.990Z')).toBe(INSTANT)
    expect(toEpochMs('2026-09-22T12:24:07.990-07:00')).toBe(INSTANT)
    expect(toEpochMs(new Date(INSTANT))).toBe(INSTANT)
    expect(toEpochMs(INSTANT)).toBe(INSTANT)
    expect(toDate(NAIVE_UTC).getTime()).toBe(INSTANT)
  })

  test('missing / invalid values are 0', () => {
    expect(toEpochMs(null)).toBe(0)
    expect(toEpochMs(undefined)).toBe(0)
    expect(toEpochMs('not a date')).toBe(0)
  })
})

describe('formatDateWithTime (viewer-local)', () => {
  const now = new Date(Date.UTC(2026, 8, 22, 20, 0)) // 1:00 PM PDT

  test('a 19:24 UTC row renders as 12:24 PM for a PDT viewer', () => {
    expect(formatDateWithTime(NAIVE_UTC, now)).toBe('Today, 12:24 PM')
    expect(formatDateWithTime(new Date(INSTANT), now)).toBe('Today, 12:24 PM')
  })

  test('day boundaries follow the viewer, not UTC', () => {
    // 01:30 UTC on the 22nd is still 6:30 PM on the 21st in PDT.
    expect(formatDateWithTime('2026-09-22 01:30:00', now)).toBe(
      'Yesterday, 06:30 PM'
    )
  })
})

describe('groupRecentChats', () => {
  const row = (id: string, lastViewedAt: Date | string): RecentChat => ({
    id,
    title: id,
    lastViewedAt: lastViewedAt as Date,
    createdAt: toDate(lastViewedAt)
  })
  // 11:00 PM PDT on the 21st == 06:00 UTC on the 22nd.
  const now = new Date(Date.UTC(2026, 8, 22, 6, 0))
  const chats = [
    row('late', new Date(Date.UTC(2026, 8, 22, 5, 0))), // 10 PM PDT 21st
    row('noon', '2026-09-21 19:00:00') // naive UTC → noon PDT 21st
  ]

  test('local grouping buckets by the viewer day', () => {
    const groups = groupRecentChats(chats, { now, local: true })
    expect(groups.map(g => [g.label, g.chats.map(c => c.id)])).toEqual([
      ['Today', ['late', 'noon']]
    ])
  })

  test('the pre-hydration UTC grouping is zone-independent', () => {
    // UTC days: 05:00Z on the 22nd is "today", 19:00Z on the 21st is not.
    const groups = groupRecentChats(chats, { now, local: false })
    expect(groups.map(g => [g.label, g.chats.map(c => c.id)])).toEqual([
      ['Today', ['late']],
      ['Yesterday', ['noon']]
    ])
  })
})

describe('optimistic merge vs naive-UTC server values (PDT viewer)', () => {
  // Server rows as a raw naive UTC string would arrive (cast: the prop type is
  // Date, but a naive string must still compare as the right instant).
  const server = [
    {
      id: 'older',
      title: 'Older',
      lastViewedAt: '2026-09-22 19:24:07.99',
      createdAt: '2026-09-22 19:00:00'
    },
    {
      id: 'newer',
      title: 'Newer',
      lastViewedAt: '2026-09-22 19:30:00',
      createdAt: '2026-09-22 19:10:00'
    }
  ] as unknown as RecentChat[]

  // Reopened at 12:35 PM PDT == 19:35 UTC — fresher than both server stamps,
  // but EARLIER than them if they were misread as local (02:24/02:30 UTC 23rd).
  const bump = Date.UTC(2026, 8, 22, 19, 35)

  test('a fresh bump wins over the naive-UTC server value and moves to top', () => {
    const merged = applyOptimisticRecent(server, {
      older: { lastViewedAt: bump }
    })
    expect(merged.map(c => c.id)).toEqual(['older', 'newer'])
    expect(toEpochMs(merged[0].lastViewedAt)).toBe(bump)
  })

  test('the bump is kept until the server catches up, then pruned', () => {
    const overrides = { older: { lastViewedAt: bump } }
    expect(pruneReconciledOverrides(server, overrides)).toBe(overrides)

    const caughtUp = [
      { ...server[0], lastViewedAt: '2026-09-22 19:35:00' },
      server[1]
    ] as unknown as RecentChat[]
    expect(pruneReconciledOverrides(caughtUp, overrides)).toEqual({})
  })

  test('server order is preserved without overrides', () => {
    expect(applyOptimisticRecent(server, {}).map(c => c.id)).toEqual([
      'newer',
      'older'
    ])
  })
})
