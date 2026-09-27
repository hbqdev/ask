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

/**
 * The ids the search-mode prompts use in their worked citation example
 * (lib/agents/prompts/search-mode-prompts.ts). Defined here, not there, so the
 * resolver can recognise a verbatim copy of one (see isPlaceholderAnchorId)
 * without the client bundle importing the prompt module.
 */
export const PROMPT_EXAMPLE_SEARCH_ID = '3f2b8c1e-9a4d-4e67-b5c0-7d1e2a9f4c86'
export const PROMPT_EXAMPLE_FETCH_ID = 'b71c05d9-2e8f-4a3b-9d6e-40f8a1c3e527'

/**
 * Anchor ids that are template tokens or instruction examples, not ids of any
 * real call: the word itself (`toolCallId`), lettered labels (`id-A`), and
 * every example id the prompts have ever shown (the pre-2026-08-02 ones were
 * copied verbatim 125 times). Lower-cased; matched case-insensitively.
 */
const PLACEHOLDER_ANCHOR_IDS = new Set(
  [
    'toolCallId',
    'tool_call_id',
    'tool-call-id',
    'id',
    'search_id',
    'fetch_id',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'mK3pQr7sT9uV2wX4',
    'I8NzFUKwrKX88107',
    'aHvy9Vt17r3VSmnG',
    'abc123',
    'def456',
    'ABC123xyz',
    PROMPT_EXAMPLE_SEARCH_ID,
    PROMPT_EXAMPLE_FETCH_ID
  ].map(id => id.toLowerCase())
)

/**
 * True for an anchor id copied from the instructions rather than from a tool
 * result: an angle-bracketed template token (`<id-A>`, `<fetch-id>`,
 * `<toolCallId>`), a lettered label (`id-A`), or a listed example id. A real id
 * wrapped in template syntax (`<id-470411cd-…>`) is NOT a placeholder — it is
 * unwrapped and looked up as that id instead (see unwrapTemplateId).
 */
export function isPlaceholderAnchorId(anchorId: string): boolean {
  const id = anchorId.trim()
  if (PLACEHOLDER_ANCHOR_IDS.has(id.toLowerCase())) return true
  if (/^id[-_][a-z]$/i.test(id)) return true
  const bracketed = /^<([^<>]+)>$/.exec(id)
  if (!bracketed) return false
  // `<id-UUID>` names one specific call: a wrong one if it is not this turn's
  // (unwrapTemplateId already tried), so it must be dropped, not treated as a
  // generic placeholder that may stand for the turn's only call.
  const inner = bracketed[1].trim().replace(/^id[-_:]/i, '')
  return PLACEHOLDER_ANCHOR_IDS.has(inner.toLowerCase()) || !UUID_RE.test(inner)
}

/**
 * The real id inside template syntax: `<id-470411cd-…>` → `470411cd-…`,
 * `<470411cd-…>` → `470411cd-…`. Measured on the lab (kimi-k2.6, 2026-09-26):
 * the model copied the example's `<id-A>` shape around the correct id, so the
 * whole answer's citations were dropped although every id was right. Returns
 * undefined when there is nothing to unwrap.
 */
function unwrapTemplateId(anchorId: string): string | undefined {
  let id = anchorId.trim()
  const bracketed = /^<([^<>]+)>$/.exec(id)
  if (bracketed) id = bracketed[1].trim()
  id = id.replace(/^id[-_:]/i, '')
  return id && id !== anchorId ? id : undefined
}

/**
 * Tool type ('tool-search', 'tool-fetch', …) of each per-call citation map
 * extractCitationMaps builds, keyed by the map object itself. It lets rendering
 * apply the fetch-only out-of-range rule without changing the
 * Record<toolCallId, Record<N, item>> shape every component passes around. A
 * hand-built map has no entry, so the rule simply does not apply to it.
 */
const CITATION_MAP_TOOL_TYPE = new WeakMap<object, string>()

/**
 * A failed fetch still yields one result (fetch.ts: `Fetch failed: <url>`) so
 * the agent can continue; it is not a page the answer was written from.
 */
const FAILED_FETCH_TITLE_RE = /^Fetch failed:/

/** The highest citation number resolveCitationAnchor will resolve. */
export const MAX_CITATION_NUMBER = 100

/**
 * Whether a tool result may be handed a ready-made citation string
 * (lib/utils/citation-handles.ts): citing it renders — a valid URL, the check
 * resolveWithinCall applies — and it is a page the answer can be written from,
 * not a failed-fetch placeholder.
 */
export function isCitableResult(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const { url, title } = item as { url?: unknown; title?: unknown }
  if (typeof url !== 'string' || !isValidUrl(url)) return false
  return !(typeof title === 'string' && FAILED_FETCH_TITLE_RE.test(title))
}

export type CitationRepair =
  /** The id is a URL fragment of exactly one source (resolveByUrlFragment). */
  | 'url-fragment'
  /** A real id of this turn wrapped in template syntax, e.g. `<id-…>`. */
  | 'wrapped-id'
  /** A placeholder id in a turn with exactly one citable call. */
  | 'placeholder'
  /** A real single-page fetch id with a number past its one result. */
  | 'fetch-out-of-range'

export type CitationResolution =
  | { status: 'own'; source: SearchResultItem }
  | { status: 'recovered'; source: SearchResultItem; repair: CitationRepair }
  | { status: 'unresolved' }

const UNRESOLVED: CitationResolution = { status: 'unresolved' }

function findCitationMap(
  anchorId: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): Record<number, SearchResultItem> | undefined {
  // Prefer an exact match to avoid side effects, then fall back to
  // prefix-normalized matching so ids the model prepended a prefix to (e.g.
  // `toolu_<id>`) still resolve.
  const exact = citationMaps[anchorId]
  if (exact) return exact
  const normalizedId = stripToolCallPrefix(anchorId)
  return (
    citationMaps[normalizedId] ??
    citationMaps[
      Object.keys(citationMaps).find(
        key => stripToolCallPrefix(key) === normalizedId
      ) ?? ''
    ]
  )
}

function resolveWithinCall(
  num: number,
  citationMap: Record<number, SearchResultItem>,
  repair: CitationRepair | null
): CitationResolution {
  const hit = citationMap[num]
  if (hit) {
    if (!isValidUrl(hit.url)) return UNRESOLVED
    return repair
      ? { status: 'recovered', source: hit, repair }
      : { status: 'own', source: hit }
  }
  // Out of range. A fetch of ONE page has one result, so its id alone names
  // the source whatever number the model put on it (models that number
  // sources as a running count across the answer write [3](#<fetchId>)). A
  // search, or a fetch of several urls, has many results and a wrong number
  // does not say which one was meant — dropped, never guessed.
  if (CITATION_MAP_TOOL_TYPE.get(citationMap) !== 'tool-fetch') {
    return UNRESOLVED
  }
  const results = Object.values(citationMap)
  const only = results.length === 1 ? results[0] : undefined
  if (
    !only ||
    !isValidUrl(only.url) ||
    FAILED_FETCH_TITLE_RE.test(only.title ?? '')
  ) {
    return UNRESOLVED
  }
  return {
    status: 'recovered',
    source: only,
    repair: repair ?? 'fetch-out-of-range'
  }
}

/**
 * THE resolution of one `[N](#id)` anchor against one message's citation
 * maps. Rendering (processCitations), the telemetry audit (auditCitations) and
 * the cited-URL list (extractCitedSourceUrls) all call this, so what the
 * counter reports is exactly what the reader sees.
 *
 * N is the 1-based position of the result inside THAT tool call's `results`
 * (extractCitationMaps). Repairs apply only where the intended source is
 * unambiguous; everything else — another turn's id, an invented id, an
 * ambiguous placeholder, a wrong number on a multi-result call — is dropped:
 *
 *   own                 the id is one of this message's calls, N in range
 *   wrapped-id          `<id-UUID>` / `<UUID>` around one of this message's ids
 *   placeholder         a template/example id, and the message made exactly ONE
 *                       citable call (the same "exactly one thing it can mean"
 *                       rule as the URL-fragment repair)
 *   fetch-out-of-range  N past the end of a single-page fetch
 *   url-fragment        the id is a fragment of exactly one source URL
 */
export function resolveCitationAnchor(
  num: number,
  anchorId: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): CitationResolution {
  if (!citationMaps || !anchorId) return UNRESOLVED
  if (!Number.isInteger(num) || num < 1 || num > MAX_CITATION_NUMBER) {
    return UNRESOLVED
  }

  const direct = findCitationMap(anchorId, citationMaps)
  if (direct) return resolveWithinCall(num, direct, null)

  const unwrapped = unwrapTemplateId(anchorId)
  const wrapped = unwrapped && findCitationMap(unwrapped, citationMaps)
  if (wrapped) return resolveWithinCall(num, wrapped, 'wrapped-id')

  if (isPlaceholderAnchorId(anchorId)) {
    const calls = Object.values(citationMaps)
    return calls.length === 1
      ? resolveWithinCall(num, calls[0], 'placeholder')
      : UNRESOLVED
  }

  const byUrl = resolveByUrlFragment(anchorId, citationMaps)
  return byUrl
    ? { status: 'recovered', source: byUrl, repair: 'url-fragment' }
    : UNRESOLVED
}

export interface CitationAudit {
  /** Anchors in this message that processCitations will try to resolve. */
  total: number
  /**
   * Anchors naming a tool call this same message made, with a number that is
   * one of that call's results — rendered as written.
   */
  own: number
  /**
   * Anchors rendered only through a repair (see resolveCitationAnchor): a URL
   * fragment, a wrapped or placeholder id, or a number past a single-page
   * fetch's one result.
   */
  recovered: number
  /**
   * Anchors that render as NOTHING — another turn's tool call, an id that
   * exists nowhere, an ambiguous placeholder, or a real id with a number that
   * is not one of its results. Until 2026-09-26 a real id with an
   * out-of-range number was scored as resolved although it rendered nothing,
   * so this counter under-reported; it now equals total - own - recovered by
   * the same resolution rendering uses.
   */
  unresolved: number
}

/**
 * Count a finished assistant message's citation anchors against the tool calls
 * that message itself made.
 *
 * Deliberately scoped to ONE message, because that is the only correct scope: a
 * citation can only be supported by a search this turn ran. Rendering builds
 * one map per message too (components/chat-messages.tsx), so an anchor carried
 * over from an earlier turn is dropped, and counted here as unresolved.
 *
 * Pure and message-local so it can run server-side in onFinish, where the
 * assembled message is available but the render-time maps are not.
 */
export function auditCitations(message: {
  parts?: unknown[] | null
}): CitationAudit {
  let total = 0
  let own = 0
  let recovered = 0
  let maps: Record<string, Record<number, SearchResultItem>> | null = null

  for (const raw of message?.parts ?? []) {
    const part = raw as { type?: string; text?: unknown } | null
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    for (const match of part.text.matchAll(CITATION_ANCHOR_RE)) {
      total++
      maps ??= extractCitationMaps(message as UIMessage)
      const resolution = resolveCitationAnchor(
        parseInt(match[1], 10),
        match[2],
        maps
      )
      if (resolution.status === 'own') own++
      else if (resolution.status === 'recovered') recovered++
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
        CITATION_MAP_TOOL_TYPE.set(citationMap, part.type)
      }
    }
  })

  return citationMaps
}

/**
 * The distinct source URLs an assistant message actually CITED — each
 * [N](#toolCallId) anchor resolved against THIS message's own tool calls by
 * resolveCitationAnchor, the same resolution rendering and auditCitations use
 * (out-of-turn anchors resolve to nothing and are dropped). Used by the shadow
 * crop-position measurement to scope its number to cited (not merely read)
 * sources.
 */
export function extractCitedSourceUrls(message: UIMessage): string[] {
  const maps = extractCitationMaps(message)
  const urls = new Set<string>()
  for (const part of (message.parts ?? []) as Array<{
    type?: string
    text?: string
  }>) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    for (const m of part.text.matchAll(CITATION_ANCHOR_RE)) {
      const resolution = resolveCitationAnchor(parseInt(m[1], 10), m[2], maps)
      if (resolution.status !== 'unresolved') urls.add(resolution.source.url)
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

  // Replace [number](#toolCallId) with [domain](actual-url), resolved by
  // resolveCitationAnchor (the same resolution auditCitations counts). An
  // anchor that does not resolve — out-of-range number, another turn's id, an
  // invented one — is dropped. Also handles spaces: [ number ].
  return content.replace(CITATION_ANCHOR_RE, (_match, num, toolCallId) => {
    const resolution = resolveCitationAnchor(
      parseInt(num, 10),
      toolCallId,
      citationMaps
    )
    if (resolution.status === 'unresolved') return ''
    const { url } = resolution.source
    // Display the domain name (removes TLD and subdomain); encode the URI to
    // prevent injection attacks.
    return `[${displayUrlName(url)}](${encodeURI(url)})`
  })
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
