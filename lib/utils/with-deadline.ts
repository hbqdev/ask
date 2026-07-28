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
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // `fallback()` is called INSIDE the try: a fallback that throws would
      // otherwise escape into the timer callback with `settled` already true,
      // so `resolve` would never be called and `work.then(finish)` would
      // short-circuit on the settled check — leaving the promise permanently
      // unsettled. A deadline helper that can hang is worse than no deadline,
      // so a throwing fallback is contained and surfaces as a rejection.
      try {
        resolve(fallback())
      } catch (error) {
        reject(error)
      }
    }, ms)

    const finish = (value: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    work.then(finish).catch(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        resolve(fallback())
      } catch (error) {
        reject(error)
      }
    })
  })
}
