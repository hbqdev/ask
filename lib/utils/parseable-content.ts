/**
 * Guards for the legacy crawl path, which downloads a whole response into a
 * string and hands it to Readability + JSDOM.
 *
 * Without these it will happily pull a multi-megabyte PDF, concatenate the
 * binary into a JS string, and parse it as HTML — producing junk that then
 * fails isQualityContent anyway. Measured: 4-5 such pages accounted for
 * 40-59s of a search turn, roughly half the wall-clock, and that parsing runs
 * on the Node event loop, so it stalls unrelated requests too.
 *
 * These pages are exactly Crawl4AI's per-page failures (PDFs, antibot walls),
 * so this is the tail that survives the renderer.
 */

/** Refuse anything larger than this before parsing. A long article is ~100KB. */
export const MAX_PARSEABLE_BYTES = 3_000_000

const PARSEABLE = [
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
  'text/plain'
]

/**
 * Can this content-type usefully be parsed as a web page?
 *
 * A MISSING content-type returns true: plenty of real pages omit the header,
 * and refusing them would lose genuine sources — the opposite of the point.
 */
export function isParseableContentType(contentType?: string | null): boolean {
  if (!contentType) return true
  const essence = contentType.trim().toLowerCase().split(';')[0].trim()
  if (!essence) return true
  return PARSEABLE.includes(essence)
}
