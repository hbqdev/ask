import { useSyncExternalStore } from 'react'

/**
 * Time helpers for the sidebar chat lists.
 *
 * `chats.created_at` / `chats.last_viewed_at` are `timestamp WITHOUT time zone`
 * columns holding UTC wall-clock values (the DB session runs in UTC and every
 * write is `new Date()` / `now()`). Drizzle's `timestamp` column already maps
 * them to correct `Date`s (it appends `+0000`), but any path that hands over a
 * RAW naive string ("2026-09-22 19:24:07.99", e.g. a raw `sql` select or a
 * JSON round-trip that dropped the offset) would be parsed by `new Date()` as
 * the VIEWER'S local time — 7h off for a PDT viewer, and future-dated, which
 * would make a fresh optimistic bump lose the `max(server, optimistic)` merge.
 * `toEpochMs` treats an offset-less string as UTC so every comparison and
 * format works on the same absolute instant.
 */

// An ISO-ish date-time with no trailing `Z` / `±hh[:mm]` offset.
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/** Absolute epoch ms for a Date / date string; naive strings are read as UTC. 0 if missing/invalid. */
export function toEpochMs(
  d: Date | string | number | null | undefined
): number {
  if (d == null || d === '') return 0
  let t: number
  if (d instanceof Date) t = d.getTime()
  else if (typeof d === 'number') t = d
  else {
    const s = d.trim()
    t = NAIVE_DATE_TIME.test(s)
      ? new Date(`${s.replace(' ', 'T')}Z`).getTime()
      : new Date(s).getTime()
  }
  return Number.isNaN(t) ? 0 : t
}

/** `toEpochMs` as a Date (naive strings read as UTC). */
export function toDate(d: Date | string | number): Date {
  return new Date(toEpochMs(d))
}

const sameLocalDay = (a: Date, b: Date) =>
  a.getDate() === b.getDate() &&
  a.getMonth() === b.getMonth() &&
  a.getFullYear() === b.getFullYear()

/**
 * "Today, 12:24 PM" / "Yesterday, …" / "09/20/2026, 12:24 PM" in the RUNTIME's
 * local time zone. Only call this in the browser (after hydration): on the
 * server it would format in the container's zone (UTC).
 */
export function formatDateWithTime(
  date: Date | string,
  now: Date = new Date()
): string {
  const parsed = toDate(date)
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const time = parsed.toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  })

  if (sameLocalDay(parsed, now)) return `Today, ${time}`
  if (sameLocalDay(parsed, yesterday)) return `Yesterday, ${time}`
  return parsed.toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  })
}

const noopSubscribe = () => () => {}

/**
 * false on the server AND during the hydration render, true afterwards.
 *
 * Anything that depends on the viewer's time zone (row times, Today/Yesterday
 * grouping) must wait for this: the server renders in the container's zone
 * (UTC), and React does NOT patch a mismatched text node on hydration (with
 * `suppressHydrationWarning` it silently keeps the server's UTC text) — which
 * is how the Recent rows showed "07:24 PM" for a 12:24 PM PDT chat.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  )
}
