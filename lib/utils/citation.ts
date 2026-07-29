import type { SearchResultItem, SearchResults } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'
import { displayUrlName } from '@/lib/utils/domain'

/**
 * Validate if a string is a valid URL
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

export function isCitationLabel(label: string): boolean {
  return /^[\w-]+(?:\.[\w-]+)*$/.test(label)
}

/**
 * Strip a known provider/router prefix from a toolCallId.
 * Some models prepend their own prefix (e.g. `toolu_`) to the search tool's
 * call id when citing, which breaks an exact-match lookup. Normalizing both the
 * cited id and the citation map keys lets these citations still resolve.
 */
function stripToolCallPrefix(toolCallId: string): string {
  return toolCallId.replace(/^(toolu_|call_|search-)/, '')
}

/**
 * Extract citation maps from a message's tool parts
 * Returns a map of toolCallId to citation map
 */
export function extractCitationMaps(
  message: UIMessage
): Record<string, Record<number, SearchResultItem>> {
  const citationMaps: Record<string, Record<number, SearchResultItem>> = {}

  if (!message.parts) return citationMaps

  message.parts.forEach((part: any) => {
    // Check for search tool output
    if (
      part.type === 'tool-search' &&
      part.state === 'output-available' &&
      part.output &&
      part.toolCallId
    ) {
      const searchResults = part.output as SearchResults

      // Prefer citationMap when present (older persisted messages still carry
      // it). Newer search outputs omit the redundant citationMap, so derive it
      // from results by index (citation N -> results[N-1]).
      let citationMap = searchResults.citationMap
      if (!citationMap && Array.isArray(searchResults.results)) {
        citationMap = {}
        searchResults.results.forEach((result, index) => {
          citationMap![index + 1] = result // Citation numbers start at 1
        })
      }

      if (citationMap && Object.keys(citationMap).length > 0) {
        // Store citation map with toolCallId as key
        citationMaps[part.toolCallId] = citationMap
      }
    }
  })

  return citationMaps
}

/**
 * Extract citation maps from multiple messages
 * Returns a combined map of toolCallId to citation map
 */
export function extractCitationMapsFromMessages(
  messages: UIMessage[]
): Record<string, Record<number, SearchResultItem>> {
  const combinedCitationMaps: Record<
    string,
    Record<number, SearchResultItem>
  > = {}

  messages.forEach(message => {
    const messageCitationMaps = extractCitationMaps(message)
    // Merge citation maps from this message
    Object.assign(combinedCitationMaps, messageCitationMaps)
  })

  return combinedCitationMaps
}

/**
 * Process citations in content, replacing [number](#toolCallId) with [domain](url)
 * Display text uses domain name instead of number (e.g., [google](url))
 */
export function processCitations(
  content: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): string {
  if (!citationMaps || !content || Object.keys(citationMaps).length === 0) {
    return content || ''
  }

  // Replace [number](#toolCallId) with [domain](actual-url)
  // Also handle cases with spaces: [ number ]
  const withAnchors = content.replace(
    /\[\s*(\d+)\s*\]\(#([^)]+)\)/g,
    (_match, num, toolCallId) => {
      const citationNum = parseInt(num, 10)

      // Validate citation number bounds
      if (isNaN(citationNum) || citationNum < 1 || citationNum > 100) {
        return '' // Return empty string for invalid citation numbers
      }

      // Get the citation map for this toolCallId. Prefer an exact match to
      // avoid side effects, then fall back to prefix-normalized matching so
      // ids the model prepended a prefix to (e.g. `toolu_<id>`) still resolve.
      let citationMap = citationMaps[toolCallId]
      if (!citationMap) {
        const normalizedId = stripToolCallPrefix(toolCallId)
        citationMap =
          citationMaps[normalizedId] ??
          citationMaps[
            Object.keys(citationMaps).find(
              key => stripToolCallPrefix(key) === normalizedId
            ) ?? ''
          ]
      }
      if (!citationMap) {
        return '' // Return empty string if no citation map found
      }

      const citation = citationMap[citationNum]
      if (!citation || !isValidUrl(citation.url)) {
        return '' // Return empty string for invalid citations
      }

      // Extract domain name from URL (removes TLD and subdomain)
      const domainName = displayUrlName(citation.url)

      // Encode URI to prevent injection attacks
      return `[${domainName}](${encodeURI(citation.url)})`
    }
  )

  return resolveBareCitations(withAnchors, citationMaps)
}

/**
 * Split content into alternating non-code and code segments.
 *
 * Fenced blocks (```) and inline spans (`) are returned as code so callers can
 * leave them untouched. Rewriting inside them would corrupt the very thing a
 * code block exists to reproduce verbatim.
 */
function splitCodeSegments(
  content: string
): { text: string; isCode: boolean }[] {
  const segments: { text: string; isCode: boolean }[] = []
  // Fenced blocks first (they may contain backticks), then inline spans.
  const pattern = /```[\s\S]*?```|`[^`\n]*`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(content)) !== null) {
    if (m.index > last) {
      segments.push({ text: content.slice(last, m.index), isCode: false })
    }
    segments.push({ text: m[0], isCode: true })
    last = m.index + m[0].length
  }
  if (last < content.length) {
    segments.push({ text: content.slice(last), isCode: false })
  }
  return segments
}

/**
 * Resolve `[1]` written WITHOUT an anchor, when — and only when — there is
 * exactly one source to resolve it against.
 *
 * WHY THIS IS NEEDED. The pipeline prompt states the anchored format
 * explicitly and forbids a bare marker, and models mostly comply — but not
 * always. Measured on a 16-probe run: one of 14 sourced answers came back with
 * 18 bare `[N]` markers and zero anchored ones. That answer LOOKS cited and is
 * completely unsourced in the UI, because the replacement above only matches
 * `[N](#id)` and leaves a bare `[N]` as literal text. A dead marker is worse
 * than no marker: it presents unattributed text as attributed.
 *
 * WHY IT IS SAFE ONLY WITH ONE MAP. Under the pipeline a turn has exactly one
 * retrieval and therefore one anchor, so `[3]` can only mean the third source.
 * A loop turn with several searches has several maps and a bare `[3]` is
 * genuinely ambiguous — guessing there would attach real URLs to claims they
 * may not support, which is worse than leaving the marker dead. So this pass
 * does nothing unless there is precisely one map.
 *
 * FALSE POSITIVES ARE THE REAL RISK, since this runs over prose that often
 * discusses code. Three guards, all necessary:
 *   - code fences and inline spans are skipped entirely;
 *   - the marker must not be preceded by a word character, so `arr[1]` and
 *     `matches[2]` are left alone while ". [1]" is resolved;
 *   - the number must exist in the map, so `[47]` alongside 9 sources stays
 *     untouched rather than being deleted as an invalid citation.
 */
function resolveBareCitations(
  content: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): string {
  const ids = Object.keys(citationMaps)
  if (ids.length !== 1) return content

  const citationMap = citationMaps[ids[0]]

  return splitCodeSegments(content)
    .map(seg => {
      if (seg.isCode) return seg.text
      return seg.text.replace(
        /(^|[^\w`])\[\s*(\d+)\s*\](?!\()/g,
        (match, before: string, num: string) => {
          const citation = citationMap[parseInt(num, 10)]
          // Unknown number: leave the text exactly as written. Deleting it (as
          // the anchored path does for an invalid citation) would silently
          // edit prose that may not have been a citation at all.
          if (!citation || !isValidUrl(citation.url)) return match
          return `${before}[${displayUrlName(citation.url)}](${encodeURI(
            citation.url
          )})`
        }
      )
    })
    .join('')
}

/**
 * Collapse whitespace and punctuation artifacts left behind by stripped
 * citations. When a model fabricates a citation anchor (e.g. `[1](#fetch_prevention)`)
 * and `processCitations` returns `''` for it, the surrounding text can end
 * up with double-spaces, double-periods, or stray commas after the period.
 *
 * Examples (before → after):
 *   "text .[1](#fake) more"  → "text. more"  (model wrote "text ." before [1])
 *   "text  more"             → "text more"
 *   "text.. more"            → "text. more"
 *   "text. ,more"            → "text. more"
 *   "Hello. World"           → "Hello. World"  (unchanged, already clean)
 */
export function collapseCitationArtifacts(text: string): string {
  if (!text) return text

  return (
    text
      .replace(/[ \t]{2,}/g, ' ') // collapse multiple spaces (but keep newlines)
      .replace(/([.!?])\s*\./g, '$1') // ".." → "."
      // The artifact: "text . word" came from "text .[1] word" → "text . word"
      // We want "text. word" — drop the lone space before a sentence-ending
      // punctuation that is itself followed by a single space + word.
      .replace(/(\w)\s+([.!?])\s+(\w)/g, '$1$2 $3')
      // Drop duplicate punctuation (with optional whitespace between):
      // ".." / ".," / ". ," / ". ." all collapse to "."
      .replace(/([.!?])[\s,;:.!?]+(?=[.!?])/g, '$1')
      // Drop a comma that sits between a period and a word: ". ,more" or "., more" → ". more"
      .replace(/([.!?])\s*,\s*(\w)/g, '$1 $2')
      // Re-collapse any double spaces that the rules above may have introduced
      .replace(/[ \t]{2,}/g, ' ')
  )
}
