import { DeepPartial } from 'ai'
import { z } from 'zod'

/**
 * Hard cap on URLs per fetch call.
 *
 * Batching exists to remove MODEL round trips, not to enable scraping: each
 * fetch call costs a full call → wait → read → decide cycle, so three separate
 * fetches cost three of those on top of three page loads. Measured turns spent
 * 80.1s in fetch across just 3 calls for exactly this reason.
 *
 * Capped at 5 because the pages still run concurrently against the same rescue
 * chain (Crawl4AI, FlareSolverr) that the crawl stage shares, and unbounded
 * fan-out there is measurably worse than bounded — see map-with-concurrency.ts.
 */
export const FETCH_MAX_URLS = 5

export const fetchSchema = z.object({
  url: z
    .union([z.string(), z.array(z.string())])
    .describe(
      `The URL to retrieve content from. Pass an ARRAY of URLs to fetch several pages in ONE call — strongly preferred when you already know you need more than one, because each separate fetch call costs an extra round trip. Up to ${FETCH_MAX_URLS} URLs per call; they are fetched concurrently, so N urls cost about the same wall-clock time as the slowest one.`
    ),
  type: z
    .enum(['regular', 'api'])
    .default('regular')
    .describe(
      'Fetch method: "regular" (default) = fast direct HTML fetch for simple web pages (does NOT support PDFs), "api" = advanced extraction for PDFs and complex JavaScript-rendered pages (requires Jina or Tavily API keys)'
    )
})

/**
 * One url or many, normalized to a bounded, deduped, non-empty list.
 *
 * Tolerant by design: the model sees a union type, and persisted messages from
 * before batching carry a bare string. Both must keep working, and a malformed
 * entry should cost that entry rather than the whole call.
 */
export function normalizeFetchUrls(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : [input]
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue
    const url = candidate.trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= FETCH_MAX_URLS) break
  }
  return out
}

/** First url, for UI affordances that address a single page (title, open-in-tab). */
export function primaryFetchUrl(
  input: string | string[] | undefined
): string | undefined {
  if (input === undefined) return undefined
  return normalizeFetchUrls(input)[0]
}

export type PartialInquiry = DeepPartial<typeof fetchSchema>
