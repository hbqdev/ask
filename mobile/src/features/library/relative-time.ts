// The time a Library row shows: the time of day for today, otherwise how
// long ago in words ("yesterday", "3 days ago", "last month"). Days are
// counted between the device's local midnights.

const DAY_MS = 24 * 60 * 60 * 1000

type Formatters = {
  timeOfDay: Intl.DateTimeFormat
  words: Intl.RelativeTimeFormat
}

// Built once per locale: a long list formats a time for every row it renders.
const formatters = new Map<string, Formatters>()

function formattersFor(locale: string | undefined): Formatters {
  const key = locale ?? ''
  let found = formatters.get(key)
  if (!found) {
    found = {
      timeOfDay: new Intl.DateTimeFormat(locale, {
        hour: 'numeric',
        minute: '2-digit'
      }),
      words: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    }
    formatters.set(key, found)
  }
  return found
}

const midnight = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/**
 * `iso` relative to `now`, in `locale` (the device's by default). A time in
 * the future (a skewed clock) shows as a time of day; an unreadable date as
 * nothing.
 */
export function relativeTime(iso: string, now: Date, locale?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  // Rounded: a day with a DST change is 23 or 25 hours long.
  const days = Math.round((midnight(now) - midnight(date)) / DAY_MS)
  const { timeOfDay, words } = formattersFor(locale)
  if (days <= 0) return timeOfDay.format(date)
  if (days < 7) return words.format(-days, 'day')
  if (days < 30) return words.format(-Math.floor(days / 7), 'week')
  if (days < 365) return words.format(-Math.floor(days / 30), 'month')
  return words.format(-Math.floor(days / 365), 'year')
}
