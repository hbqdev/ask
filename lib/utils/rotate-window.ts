// Return `count` items from `pool` starting at `start`, wrapping around the end.
// Used by the news widget to slide a window across the article pool as it
// auto-cycles. Pure so the cycling logic is unit-testable without timers.
//
// - count is clamped to pool.length (never returns duplicates within one window
//   unless pool is shorter than count, in which case it returns the whole pool).
// - start is taken modulo pool.length, so any integer (incl. a running counter)
//   is valid.
export function rotateWindow<T>(pool: T[], start: number, count: number): T[] {
  const n = pool.length
  if (n === 0 || count <= 0) return []
  const take = Math.min(count, n)
  const base = ((start % n) + n) % n // normalise, tolerate negatives
  const out: T[] = []
  for (let i = 0; i < take; i++) out.push(pool[(base + i) % n])
  return out
}
