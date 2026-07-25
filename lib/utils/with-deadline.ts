/**
 * Resolve `work` unless it overruns `ms`, in which case resolve `fallback()`.
 * A rejection also takes the fallback — for best-effort work the caller wants
 * a usable value, not an exception.
 *
 * Used to bound the legacy crawl tail: those fetches allow 20s each and are
 * fired concurrently, so a single hanging page pinned an entire turn's search
 * stage at ~30s (measured). The un-finished results keep their search snippet
 * and continue through the normal quality filter and rerank.
 *
 * The timer is always cleared, so a settled promise never holds the process
 * open for the remainder of the deadline.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: () => T
): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback())
    }, ms)

    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    work.then(finish).catch(() => finish(fallback()))
  })
}
