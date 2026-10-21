// The time a Library row shows: the time of day for today, otherwise how
// long ago in words ("yesterday", "3 days ago", "last month"). Days are
// counted between the device's local midnights.

const DAY_MS = 24 * 60 * 60 * 1000

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
  if (days <= 0) {
    return new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(date)
  }
  const words = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (days < 7) return words.format(-days, 'day')
  if (days < 30) return words.format(-Math.floor(days / 7), 'week')
  if (days < 365) return words.format(-Math.floor(days / 30), 'month')
  return words.format(-Math.floor(days / 365), 'year')
}
