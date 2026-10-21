// Groups the Library's rows under date headings the way iOS lists do: Today,
// Yesterday, the previous 7 and 30 days, then one heading per month. Day
// boundaries are midnights in the device's local timezone.

import type { ChatRow } from '@/features/library/library-api'

export type DateGroup = {
  label: 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | string
  rows: ChatRow[]
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/**
 * Splits `rows` into date groups by `key` (a null `lastViewedAt` falls back to
 * `createdAt`). The input order is kept: groups come in the order their first
 * row appears, and rows keep their order within a group.
 */
export function groupByDate(
  rows: ChatRow[],
  now: Date,
  key: 'lastViewedAt' | 'createdAt'
): DateGroup[] {
  // Built from local parts, so each is that day's local midnight (DST-safe).
  const daysAgo = (n: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
  const today = daysAgo(0)
  const yesterday = daysAgo(1)
  const week = daysAgo(7)
  const month = daysAgo(30)

  const labelOf = (row: ChatRow): string => {
    const date = new Date(row[key] ?? row.createdAt)
    const t = date.getTime()
    if (t >= today) return 'Today'
    if (t >= yesterday) return 'Yesterday'
    if (t >= week) return 'Previous 7 days'
    if (t >= month) return 'Previous 30 days'
    return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
  }

  const groups = new Map<string, ChatRow[]>()
  for (const row of rows) {
    const label = labelOf(row)
    const group = groups.get(label)
    if (group) group.push(row)
    else groups.set(label, [row])
  }
  return Array.from(groups, ([label, rows]) => ({ label, rows }))
}
