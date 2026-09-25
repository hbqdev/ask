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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_URL_FRAGMENT_LENGTH = 6

function normalizeUrlForMatch(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

/**
 * Recover an anchor whose "id" is not a toolCallId at all but a piece of the
 * cited page's own URL — `[1](#1up-usa.com/how-to-change-a-bike-tire)`,
 * `[9](#2022269238895736170)` for zhihu.com/p/2022269238895736170, a YouTube
 * video id. Models do this when they cannot see the id of the call that read
 * the page (fetch results never carried one until 2026-09-23). The anchor then
 * names its source unambiguously even though the number is meaningless, so it
 * resolves to that source — but ONLY when the fragment matches exactly one
 * distinct URL among THIS message's sources. Ambiguous fragments (a bare
 * domain several results share), UUID-shaped ids (a real or invented tool call
 * — never a URL piece) and short fragments stay unresolved: an invented
 * citation is dropped, never guessed.
 *
 * Measured on prod history: 83 of 655 unresolved anchors were this shape.
 */
export function resolveByUrlFragment(
  anchorId: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): SearchResultItem | undefined {
  if (!anchorId || UUID_RE.test(anchorId)) return undefined
  const needle = normalizeUrlForMatch(anchorId)
  if (needle.length < MIN_URL_FRAGMENT_LENGTH) return undefined

  const matches = new Map<string, SearchResultItem>()
  for (const map of Object.values(citationMaps ?? {})) {
    for (const item of Object.values(map ?? {})) {
      if (!item?.url || !isValidUrl(item.url)) continue
      const key = normalizeUrlForMatch(item.url)
      if (key.includes(needle)) matches.set(key, item)
      if (matches.size > 1) return undefined
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined
}

export interface CitationAudit {
  /** Anchors in this message that processCitations will try to resolve. */
  total: number
  /** Anchors naming a toolCallId this same message actually made. */
  own: number
  /**
   * Anchors that name no tool call but uniquely name one of this message's
   * source URLs (see resolveByUrlFragment) — rendered, so not unresolved.
   */
  recovered: number
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
  let recovered = 0
  let maps: Record<string, Record<number, SearchResultItem>> | null = null
  for (const text of texts) {
    for (const match of text.matchAll(CITATION_ANCHOR_RE)) {
      total++
      if (ownIds.has(stripToolCallPrefix(match[2]))) {
        own++
        continue
      }
      maps ??= extractCitationMaps(message as UIMessage)
      if (resolveByUrlFragment(match[2], maps)) recovered++
    }
  }

  return { total, own, recovered, unresolved: total - own - recovered }
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
      const map = byStripped[stripToolCallPrefix(m[2])]
      const src = map ? map[Number(m[1])] : resolveByUrlFragment(m[2], rawMaps)
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
        // Not a tool call of this message. Resolve only when the "id" is a
        // fragment of exactly one of this message's source URLs; anything
        // else (another turn's id, an invented one) is dropped.
        const byUrl = resolveByUrlFragment(toolCallId, citationMaps)
        if (!byUrl) return ''
        return `[${displayUrlName(byUrl.url)}](${encodeURI(byUrl.url)})`
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
 * A citation anchor the stream has not finished yet, at the very end of the
 * text: `[`, `[1`, `[1](`, `[1](#`, `[1](#call_ab…`. A complete bracket with no
 * link part (`[1]`) is deliberately NOT matched — it is valid literal text a
 * finished answer may legitimately end with.
 */
const INCOMPLETE_CITATION_TAIL_RE =
  /\[[ \t]*\d{0,3}[ \t]*(?:\]\((?:#[^\s()[\]]*)?)?$/

/**
 * Drop an unfinished citation anchor from the end of streamed answer text.
 *
 * Streamdown completes an unclosed link at the stream tail (remend) as
 * `[1](streamdown:incomplete-link)`; the sanitize step strips that non-http
 * href and rehype-harden then renders the href-less link with its "blocked"
 * indicator, so every citation flashed "1 [blocked]" while its toolCallId was
 * still arriving. The anchor carries nothing displayable until its `)` lands
 * (processCitations then turns it into a source chip), so it renders as
 * nothing instead. Also covers a message persisted mid-anchor (user pressed
 * Stop), which renders through the same streaming path forever after.
 *
 * Only a tail that is prose is touched: inside an open fenced block or inline
 * code span the `[` is code, not a citation.
 */
export function stripIncompleteCitationTail(text: string): string {
  if (!text) return text
  const match = INCOMPLETE_CITATION_TAIL_RE.exec(text)
  if (!match) return text
  const before = text.slice(0, match.index)
  const fences = before.match(/^[ \t]*(?:```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return text
  const lastLine = before.slice(before.lastIndexOf('\n') + 1)
  const backticks = lastLine.match(/`/g)?.length ?? 0
  if (backticks % 2 === 1) return text
  return before
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
