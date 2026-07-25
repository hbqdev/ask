/**
 * Map over items with at most `limit` running at once, preserving input order.
 * A rejection is returned in place (as the Error) instead of aborting the rest,
 * matching Promise.allSettled semantics without the wrapper objects.
 *
 * Exists because firing every batch at once can be worse than firing fewer:
 * the Crawl4AI sidecar handled 3 concurrent chunks (24 URLs) in ~9s, but 6
 * chunks (46 URLs) pushed every chunk past its 60s timeout and returned
 * NOTHING — and an aborted chunk loses all its rendered pages, so the caller
 * then re-crawled all 46 on the slow fallback path. Unbounded fan-out turned a
 * 9s stage into 65s of wasted work.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<(R | Error)[]> {
  const effectiveLimit = limit > 0 ? limit : items.length
  const results = new Array<R | Error>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (error) {
        results[index] =
          error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(effectiveLimit, items.length) }, worker)
  )
  return results
}
