// Groups the Library's rows (chats or notes) under date headings the way iOS
// lists do: Today, Yesterday, the previous 7 and 30 days, then one heading per
// month. Day boundaries are midnights in the device's local timezone.

/** A row with the dates it can be grouped by (ISO strings). */
export type DatedRow = {
  createdAt: string
  lastViewedAt?: string | null
  updatedAt?: string
}

export type DateKey = 'lastViewedAt' | 'createdAt' | 'updatedAt'

export type DateGroup<T extends DatedRow = DatedRow> = {
  label: 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | string
  rows: T[]
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
 * Splits `rows` into date groups by `key` (a missing or null date falls back
 * to `createdAt`). The input order is kept: groups come in the order their
 * first row appears, and rows keep their order within a group.
 */
export function groupByDate<T extends DatedRow>(
  rows: T[],
  now: Date,
  key: DateKey
): DateGroup<T>[] {
  // Built from local parts, so each is that day's local midnight (DST-safe).
  const daysAgo = (n: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - n).getTime()
  const today = daysAgo(0)
  const yesterday = daysAgo(1)
  const week = daysAgo(7)
  const month = daysAgo(30)

  const labelOf = (row: T): string => {
    const date = new Date(row[key] ?? row.createdAt)
    const t = date.getTime()
    if (t >= today) return 'Today'
    if (t >= yesterday) return 'Yesterday'
    if (t >= week) return 'Previous 7 days'
    if (t >= month) return 'Previous 30 days'
    return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
  }

  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const label = labelOf(row)
    const group = groups.get(label)
    if (group) group.push(row)
    else groups.set(label, [row])
  }
  return Array.from(groups, ([label, rows]) => ({ label, rows }))
}
