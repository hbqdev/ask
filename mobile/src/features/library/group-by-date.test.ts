import { describe, expect, it } from 'vitest'

import { groupByDate } from '@/features/library/group-by-date'
import type { ChatRow } from '@/features/library/library-api'

// Every date is built from local-time parts, so the expectations hold in any
// timezone the suite runs in.
const NOW = new Date(2026, 9, 21, 15, 30) // 21 Oct 2026, 15:30 local

function row(
  id: string,
  createdAt: Date,
  lastViewedAt: Date | null = null
): ChatRow {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: createdAt.toISOString(),
    lastViewedAt: lastViewedAt ? lastViewedAt.toISOString() : null,
    fileCount: 0
  }
}

/** The groups as [label, ids] pairs, for compact expectations. */
function shape(rows: ChatRow[], key: 'lastViewedAt' | 'createdAt') {
  return groupByDate(rows, NOW, key).map(g => [g.label, g.rows.map(r => r.id)])
}

describe('groupByDate', () => {
  it('returns no groups for no rows', () => {
    expect(groupByDate([], NOW, 'createdAt')).toEqual([])
  })

  it('splits Today from Yesterday at local midnight', () => {
    const rows = [
      row('now', new Date(2026, 9, 21, 15, 0)),
      row('midnight', new Date(2026, 9, 21, 0, 0, 0)),
      row('just-before', new Date(2026, 9, 20, 23, 59, 59)),
      row('yesterday-start', new Date(2026, 9, 20, 0, 0, 0))
    ]
    expect(shape(rows, 'createdAt')).toEqual([
      ['Today', ['now', 'midnight']],
      ['Yesterday', ['just-before', 'yesterday-start']]
    ])
  })

  it('splits Yesterday from the previous 7 days at the midnight before', () => {
    const rows = [
      row('y', new Date(2026, 9, 20, 0, 0, 0)),
      row('two-days', new Date(2026, 9, 19, 23, 59, 59))
    ]
    expect(shape(rows, 'createdAt')).toEqual([
      ['Yesterday', ['y']],
      ['Previous 7 days', ['two-days']]
    ])
  })

  it('ends the previous 7 days at local midnight 7 days ago', () => {
    const rows = [
      row('day-7', new Date(2026, 9, 14, 0, 0, 0)),
      row('day-8', new Date(2026, 9, 13, 23, 59, 59))
    ]
    expect(shape(rows, 'createdAt')).toEqual([
      ['Previous 7 days', ['day-7']],
      ['Previous 30 days', ['day-8']]
    ])
  })

  it('ends the previous 30 days at local midnight 30 days ago', () => {
    const rows = [
      row('day-30', new Date(2026, 8, 21, 0, 0, 0)),
      row('day-31', new Date(2026, 8, 20, 23, 59, 59))
    ]
    expect(shape(rows, 'createdAt')).toEqual([
      ['Previous 30 days', ['day-30']],
      ['September 2026', ['day-31']]
    ])
  })

  it('keeps day boundaries at local midnight across a DST change', () => {
    // 1 Nov 2026 is a DST change in the US: in America/Los_Angeles a day
    // there is 25 hours, so counting days in fixed 24-hour steps would be off.
    const now = new Date(2026, 10, 3, 12, 0)
    const rows = [
      row('day-7', new Date(2026, 9, 27, 0, 0, 0)),
      row('day-8', new Date(2026, 9, 26, 23, 59, 59))
    ]
    const groups = groupByDate(rows, now, 'createdAt')
    expect(groups.map(g => [g.label, g.rows.map(r => r.id)])).toEqual([
      ['Previous 7 days', ['day-7']],
      ['Previous 30 days', ['day-8']]
    ])
  })

  it('labels older rows by local month and year', () => {
    const rows = [
      row('sep', new Date(2026, 8, 1, 0, 0, 0)),
      row('aug-end', new Date(2026, 7, 31, 23, 59, 59)),
      row('aug', new Date(2026, 7, 1, 0, 0, 0)),
      row('dec', new Date(2025, 11, 31, 12, 0)),
      row('jan', new Date(2025, 0, 1, 0, 0, 0))
    ]
    expect(shape(rows, 'createdAt')).toEqual([
      ['September 2026', ['sep']],
      ['August 2026', ['aug-end', 'aug']],
      ['December 2025', ['dec']],
      ['January 2025', ['jan']]
    ])
  })

  it('puts a date after now (clock skew) in Today', () => {
    const rows = [row('ahead', new Date(2026, 9, 22, 9, 0))]
    expect(shape(rows, 'createdAt')).toEqual([['Today', ['ahead']]])
  })

  it('groups by lastViewedAt, falling back to createdAt when it is null', () => {
    const rows = [
      row('viewed-today', new Date(2026, 6, 1), new Date(2026, 9, 21, 9, 0)),
      row('never-viewed', new Date(2026, 9, 20, 12, 0), null),
      row('viewed-old', new Date(2026, 6, 1), new Date(2026, 7, 5))
    ]
    expect(shape(rows, 'lastViewedAt')).toEqual([
      ['Today', ['viewed-today']],
      ['Yesterday', ['never-viewed']],
      ['August 2026', ['viewed-old']]
    ])
  })

  it('groups by createdAt even when the row was viewed', () => {
    const rows = [row('a', new Date(2026, 6, 1), new Date(2026, 9, 21, 9, 0))]
    expect(shape(rows, 'createdAt')).toEqual([['July 2026', ['a']]])
  })

  it('keeps the input order: groups in order of first appearance, rows in order within', () => {
    const rows = [
      row('old-1', new Date(2026, 5, 1)),
      row('today-1', new Date(2026, 9, 21, 8, 0)),
      row('old-2', new Date(2026, 5, 2)),
      row('today-2', new Date(2026, 9, 21, 7, 0))
    ]
    const groups = groupByDate(rows, NOW, 'createdAt')
    expect(groups.map(g => [g.label, g.rows.map(r => r.id)])).toEqual([
      ['June 2026', ['old-1', 'old-2']],
      ['Today', ['today-1', 'today-2']]
    ])
    // The rows are the caller's objects, not copies.
    expect(groups[0].rows[0]).toBe(rows[0])
  })

  it('groups any dated rows, such as notes, by their updatedAt', () => {
    const notes = [
      {
        id: 'n1',
        createdAt: new Date(2026, 6, 1).toISOString(),
        updatedAt: new Date(2026, 9, 21, 9, 0).toISOString()
      },
      {
        id: 'n2',
        createdAt: new Date(2026, 6, 1).toISOString(),
        updatedAt: new Date(2026, 6, 2).toISOString()
      }
    ]
    const groups = groupByDate(notes, NOW, 'updatedAt')
    expect(groups.map(g => [g.label, g.rows.map(r => r.id)])).toEqual([
      ['Today', ['n1']],
      ['July 2026', ['n2']]
    ])
    expect(groups[0].rows[0]).toBe(notes[0])
  })
})
