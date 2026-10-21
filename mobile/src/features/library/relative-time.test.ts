import { afterEach, describe, expect, it, vi } from 'vitest'

import { relativeTime } from '@/features/library/relative-time'

// Local times, so day boundaries are the device's midnights.
const NOW = new Date(2026, 9, 21, 15, 30)
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m, d, h, min).toISOString()
const daysAgo = (n: number, h = 12) => at(2026, 9, 21 - n, h)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('relativeTime', () => {
  it('builds its formatters once per locale, not per call', () => {
    // Spies that still build the real formatters (with `new`).
    const RealDates = Intl.DateTimeFormat
    const RealWords = Intl.RelativeTimeFormat
    const dates = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof RealDates>
    ) {
      return new RealDates(...args)
    } as never)
    const words = vi
      .spyOn(Intl, 'RelativeTimeFormat')
      .mockImplementation(function (
        ...args: ConstructorParameters<typeof RealWords>
      ) {
        return new RealWords(...args)
      } as never)
    // A locale no other test uses, so nothing is cached for it yet.
    for (const iso of [at(2026, 9, 21, 9), daysAgo(1), daysAgo(3)]) {
      relativeTime(iso, NOW, 'de-DE')
      relativeTime(iso, NOW, 'de-DE')
    }
    expect(dates).toHaveBeenCalledOnce()
    expect(words).toHaveBeenCalledOnce()
    expect(relativeTime(daysAgo(3), NOW, 'de-DE')).toBe('vor 3 Tagen')
  })

  it('shows the time of day for today', () => {
    expect(relativeTime(at(2026, 9, 21, 14, 5), NOW, 'en-US')).toMatch(
      /^2:05\sPM$/
    )
    // Just after midnight is still today.
    expect(relativeTime(at(2026, 9, 21, 0, 1), NOW, 'en-US')).toMatch(
      /^12:01\sAM$/
    )
  })

  it('says "yesterday" for any time on the day before', () => {
    expect(relativeTime(daysAgo(1, 23), NOW, 'en-US')).toBe('yesterday')
    expect(relativeTime(daysAgo(1, 0), NOW, 'en-US')).toBe('yesterday')
  })

  it('counts days within the week', () => {
    expect(relativeTime(daysAgo(3), NOW, 'en-US')).toBe('3 days ago')
    expect(relativeTime(daysAgo(6), NOW, 'en-US')).toBe('6 days ago')
  })

  it('counts weeks within the month', () => {
    expect(relativeTime(daysAgo(7), NOW, 'en-US')).toBe('last week')
    expect(relativeTime(daysAgo(20), NOW, 'en-US')).toBe('2 weeks ago')
  })

  it('counts months within the year', () => {
    expect(relativeTime(daysAgo(30), NOW, 'en-US')).toBe('last month')
    expect(relativeTime(daysAgo(100), NOW, 'en-US')).toBe('3 months ago')
  })

  it('counts years beyond that', () => {
    expect(relativeTime(daysAgo(365), NOW, 'en-US')).toBe('last year')
    expect(relativeTime(daysAgo(800), NOW, 'en-US')).toBe('2 years ago')
  })

  it('shows a time in the future (a skewed clock) as a time of day', () => {
    expect(relativeTime(at(2026, 9, 23, 9, 0), NOW, 'en-US')).toMatch(
      /^9:00\sAM$/
    )
  })

  it('shows nothing for a date it cannot read', () => {
    expect(relativeTime('not a date', NOW, 'en-US')).toBe('')
  })

  it('uses the device locale by default', () => {
    expect(relativeTime(daysAgo(3), NOW)).toBe(
      new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
        -3,
        'day'
      )
    )
  })
})
