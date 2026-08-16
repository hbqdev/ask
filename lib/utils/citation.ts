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
 * The anchors `processCitations` will actually act on. Kept here so the audit
 * below counts exactly what rendering processes — a looser pattern would report
 * anchors that are never resolved at all and just stay as literal text.
 */
const CITATION_ANCHOR_RE = /\[\s*(\d+)\s*\]\(#([^)]+)\)/g

export interface CitationAudit {
  /** Anchors in this message that processCitations will try to resolve. */
  total: number
  /** Anchors naming a toolCallId this same message actually made. */
  own: number
  /**
   * Anchors naming anything else — another turn's tool call, or an id that
   * exists nowhere. Both are defects: the first renders a confidently wrong
   * source today, the second is silently deleted. Neither is otherwise visible,
   * which is how a ~19% failure rate went unnoticed across prod's history.
   */
  unresolved: number
}

/**
 * Count a finished assistant message's citation anchors against the tool calls
 * that message itself made.
 *
 * Deliberately scoped to ONE message, because that is the only correct scope: a
 * citation can only be supported by a search this turn ran. Resolution today
 * uses a conversation-wide map (components/chat-messages.tsx), which is why an
 * anchor carried over from an earlier turn resolves cleanly to the wrong source
 * instead of failing.
 *
 * Pure and message-local so it can run server-side in onFinish, where the
 * assembled message is available but the render-time maps are not.
 */
export function auditCitations(message: {
  parts?: unknown[] | null
}): CitationAudit {
  const ownIds = new Set<string>()
  const texts: string[] = []

  for (const raw of message?.parts ?? []) {
    const part = raw as {
      type?: string
      text?: unknown
      toolCallId?: unknown
    } | null
    if (!part) continue
    // Only CITABLE tool parts count as resolvable. Counting every part with a
    // toolCallId (calculate, get_weather, todoWrite) would score an anchor as
    // resolved that extractCitationMaps never builds a map for, making the
    // counter disagree with rendering.
    if (
      typeof part.toolCallId === 'string' &&
      part.toolCallId &&
      CITABLE_TOOL_PART_TYPES.has(part.type ?? '')
    ) {
      ownIds.add(stripToolCallPrefix(part.toolCallId))
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
    }
  }

  let total = 0
  let own = 0
  for (const text of texts) {
    for (const match of text.matchAll(CITATION_ANCHOR_RE)) {
      total++
      if (ownIds.has(stripToolCallPrefix(match[2]))) own++
    }
  }

  return { total, own, unresolved: total - own }
}

/**
 * Extract citation maps from a message's tool parts
 * Returns a map of toolCallId to citation map
 */
/**
 * Tool parts whose output can back a citation.
 *
 * `fetch` belongs here for the same reason `search` does: it returns
 * `{ state, results: [{ title, url, content }] }` — the identical shape — and
 * its results are pages the answer is written from. Excluding it made fetched
 * sources structurally uncitable: the prompt told the model to cite searches
 * only, so a turn that read a page via fetch had no valid anchor for it and
 * invented one (`fetch_1`, and 74 `fetch_`/`search_`-shaped slugs across the
 * three stacks). 43% of prod assistant messages contain a fetch part, so this
 * was not an edge case.
 *
 * Shared with auditCitations deliberately. When the audit counted "any part
 * with a toolCallId" and this counted only search, a correctly-cited fetch
 * scored as resolved in telemetry while still failing to render — the counter
 * disagreeing with the thing it counts.
 */
const CITABLE_TOOL_PART_TYPES = new Set([
  'tool-search',
  'tool-fetch',
  // SPIKE (chat-with-docs): a synthetic retrieval part injected for attached
  // documents/URLs. It carries the identical { state, results: [{title,url,
  // content}] } shape as search/fetch, so the client builds a citationMap for
  // it by index the same way — letting the model cite an attached document the
  // user provided (via a fixed toolCallId the streaming layer injects) even
  // though the model never called a retrieval tool itself.
  'tool-documentRetrieval'
])

export function extractCitationMaps(
  message: UIMessage
): Record<string, Record<number, SearchResultItem>> {
  const citationMaps: Record<string, Record<number, SearchResultItem>> = {}

  if (!message.parts) return citationMaps

  message.parts.forEach((part: any) => {
    // Any tool whose output carries citable results (search, fetch)
    if (
      CITABLE_TOOL_PART_TYPES.has(part.type) &&
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
 * The distinct source URLs an assistant message actually CITED — each
 * [N](#toolCallId) anchor resolved against THIS message's own tool calls
 * (out-of-turn anchors resolve to nothing and are dropped, the same per-message
 * scoping rendering uses). Keys are normalized with stripToolCallPrefix so
 * resolution agrees with auditCitations' resolved/unresolved counts. Used by the
 * shadow crop-position measurement to scope its number to cited (not merely
 * read) sources.
 */
export function extractCitedSourceUrls(message: UIMessage): string[] {
  const rawMaps = extractCitationMaps(message)
  const byStripped: Record<string, Record<number, SearchResultItem>> = {}
  for (const [id, map] of Object.entries(rawMaps)) {
    byStripped[stripToolCallPrefix(id)] = map
  }
  const urls = new Set<string>()
  for (const part of (message.parts ?? []) as Array<{
    type?: string
    text?: string
  }>) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    for (const m of part.text.matchAll(CITATION_ANCHOR_RE)) {
      const src = byStripped[stripToolCallPrefix(m[2])]?.[Number(m[1])]
      if (src?.url) urls.add(src.url)
    }
  }
  return [...urls]
}

/**
 * Extract citation maps from multiple messages
 * Returns a combined map of toolCallId to citation map
 *
 * @deprecated Do not use for rendering. Merging maps across a conversation is
 * what let a citation anchor from one turn resolve against another turn's
 * results and render a confidently wrong source — 4% of anchors across prod's
 * history. Rendering now builds one map per message (components/chat-messages.tsx).
 * Kept only because a caller outside rendering may still want the merged view;
 * if you reach for it, be sure wrong-turn resolution is acceptable first.
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
  return content.replace(
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
