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
  /** A shortened form of exactly one of this turn's ids (findMapByIdPrefix). */
  | 'id-prefix'
  /** One of this turn's ids with one character wrong (findMapByIdTypo). */
  | 'id-typo'
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

/**
 * The fewest characters a shortened id may keep and still name a call. Eight
 * hex characters is the first group of a UUID — the shortening models produce
 * (git-style) — and 16^8 values: two calls of one turn never share it by
 * chance, and an invented 8-character id never matches one by chance.
 */
const MIN_ID_PREFIX_LENGTH = 8

/** Hex digits and dashes only: what a UUID, or any piece of one, is made of. */
const UUID_CHARS_RE = /^[0-9a-f-]+$/i

/**
 * The call a SHORTENED id names: `[3](#17d98f5d)`, `[1](#71cee5ba...)`,
 * `[2](#74661147-...)`, `[1](#bbad709f…)` for this turn's
 * `17d98f5d-f270-46f8-92e8-e2acaa3a4705`. Measured on prod (glm-5.3-flash,
 * 2026-10-06): 43 of the 48 anchors it lost since 2026-10-04 carried the
 * right id cut to its first 8 characters, many with a literal `...` after it,
 * although every result handed it the full id (those 43 sat in planning text
 * it leaked ahead of its answer). Same shape in final answers: prod glm-5.2
 * history, lab deepseek-v4-flash.
 *
 * After trimming whitespace, one trailing ellipsis (`...` or `…`) and
 * trailing dashes, the id must be at least MIN_ID_PREFIX_LENGTH hex/dash
 * characters and a case-insensitive prefix of EXACTLY ONE of this message's
 * citable call ids. Shorter, ambiguous (two calls start with it), or not a
 * prefix of any of THIS turn's calls (another turn's, or invented) → no match:
 * the anchor is dropped, never guessed.
 */
function findMapByIdPrefix(
  anchorId: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): Record<number, SearchResultItem> | undefined {
  const prefix = anchorId
    .trim()
    .replace(/(?:\.{3}|…)$/, '')
    .trimEnd()
    .replace(/-+$/, '')
    .toLowerCase()
  if (prefix.length < MIN_ID_PREFIX_LENGTH || !UUID_CHARS_RE.test(prefix)) {
    return undefined
  }
  let match: Record<number, SearchResultItem> | undefined
  for (const [id, map] of Object.entries(citationMaps)) {
    if (!id.toLowerCase().startsWith(prefix)) continue
    if (match) return undefined
    match = map
  }
  return match
}

/** Whether a and b differ by exactly one substituted, inserted or deleted character. */
function isOneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  return a.length > b.length
    ? a.slice(i + 1) === b.slice(i)
    : a.slice(i) === b.slice(i + 1)
}

/**
 * The call a full-length id with ONE character wrong names:
 * `80a47e63-d3c8-447a-a75f-50433119aebb` for this turn's `…-50433119aebc`,
 * `bf8eb24c-8a84-434b-b96-b99216f42299` (a digit dropped). Measured across
 * the three stacks' history (2026-10-06): 17 anchors (kimi-k2.6,
 * deepseek-v4-flash), every one within one edit of exactly one call of its
 * own turn and of no other id. Two random UUIDs are never one edit apart, so
 * a match names its call as surely as the full id; an id that is one edit
 * from two calls, or from none of THIS turn's, is dropped. Only UUID-shaped
 * calls are candidates — the shape whose length makes one edit meaningful.
 */
function findMapByIdTypo(
  anchorId: string,
  citationMaps: Record<string, Record<number, SearchResultItem>>
): Record<number, SearchResultItem> | undefined {
  const id = anchorId.trim().toLowerCase()
  if (!UUID_CHARS_RE.test(id)) return undefined
  let match: Record<number, SearchResultItem> | undefined
  for (const [callId, map] of Object.entries(citationMaps)) {
    if (!UUID_RE.test(callId) || !isOneEditApart(id, callId.toLowerCase())) {
      continue
    }
    if (match) return undefined
    match = map
  }
  return match
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
 *   id-prefix           a shortened id (>= 8 hex chars, optional trailing `...`)
 *                       that starts exactly ONE of this message's ids
 *   id-typo             a full-length id one character off exactly ONE of this
 *                       message's ids
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

  // Both name one call of THIS turn or nothing, and N is then resolved against
  // that call exactly as for its full id (out-of-range rules included).
  const shortened = findMapByIdPrefix(anchorId, citationMaps)
  if (shortened) return resolveWithinCall(num, shortened, 'id-prefix')
  const mistyped = findMapByIdTypo(anchorId, citationMaps)
  if (mistyped) return resolveWithinCall(num, mistyped, 'id-typo')

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
   * fragment, a wrapped, shortened, one-character-off or placeholder id, or a
   * number past a single-page fetch's one result.
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
 * Search-result text at or under this many characters is a provider snippet,
 * not page text. Basic-tier results (SearXNG / degoog snippets, Ollama web
 * truncated to 400 in providers/searxng.ts) are 150-401 chars. Crawled
 * advanced-tier results and fetched pages run to thousands. 1000 is the split
 * the 2026-09-30 quality re-test judged support by: citations whose evidence
 * was a snippet of 1000 chars or less were 71% unsupported by that text, vs
 * 23% for page text.
 */
export const SNIPPET_MAX_CHARS = 1000

// Query parameters that never select different page content: click/campaign
// trackers and feed markers. A search engine hands back
// `…/fulltext?rss=yes` while the model fetches `…/fulltext`; both are the
// same page.
const NON_CONTENT_QUERY_PARAM_RE =
  /^(?:utm_[a-z0-9_]*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|rss)$/i

/**
 * A key under which two URLs of the SAME page compare equal. Null for
 * anything that is not an http(s) URL.
 *
 * Normalizes what does not change the document: scheme, a `www.` / `m.`
 * host prefix, letter case, a trailing slash, the fragment, tracker and
 * empty-valued query parameters, and query-parameter order. Two GitHub forms
 * are the same page too: the repository page renders its README, so
 * `github.com/o/r`, `github.com/o/r?tab=…` and
 * `github.com/o/r/blob/<branch>/README.md` share a key (lab 2026-09-30: a
 * turn fetched three READMEs and cited the repo pages' 400-char snippets 22
 * times). Every other query parameter is kept, so `watch?v=a` and
 * `watch?v=b` stay different pages.
 */
export function samePageKey(url: string): string | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, '')
  let path = u.pathname.toLowerCase().replace(/\/+$/, '')
  const github = host === 'github.com'
  if (github) {
    const readme =
      /^(\/[^/]+\/[^/]+)\/blob\/[^/]+\/readme(?:\.(?:md|markdown|rst|txt))?$/.exec(
        path
      )
    if (readme) path = readme[1]
  }
  const params = [...u.searchParams]
    .filter(
      ([k, v]) =>
        v !== '' &&
        !NON_CONTENT_QUERY_PARAM_RE.test(k) &&
        // the repo page's tabs (README / license / code of conduct)
        !(github && k === 'tab')
    )
    .map(([k, v]) => `${k}=${v}`)
    .sort()
  return `${host}${path}${params.length ? `?${params.join('&')}` : ''}`
}

/**
 * Where a citation's support comes from — what the answer could have been
 * written from, given the result it cites.
 *
 *   page           the cited result itself is page text: a fetched page, an
 *                  attached-document excerpt, or a search result carrying
 *                  crawled content (longer than SNIPPET_MAX_CHARS)
 *   snippet-read   the cited result is a search snippet, but this same message
 *                  also read that page in full (a fetch of it, or a crawled
 *                  copy in another search) — the chip links the very page
 *                  that was read; only the snippet stored under it is thin
 *   snippet        a search snippet, and nothing in this message read the page
 *                  behind it
 */
export type CitationEvidence = 'page' | 'snippet-read' | 'snippet'

type CitableIndexEntry = { type: string; item: SearchResultItem }

function citableResults(message: {
  parts?: unknown[] | null
}): CitableIndexEntry[] {
  const out: CitableIndexEntry[] = []
  for (const raw of message?.parts ?? []) {
    const part = raw as {
      type?: string
      state?: string
      toolCallId?: string
      output?: { results?: unknown }
    } | null
    if (
      !part?.type ||
      !CITABLE_TOOL_PART_TYPES.has(part.type) ||
      part.state !== 'output-available' ||
      !part.toolCallId ||
      !Array.isArray(part.output?.results)
    ) {
      continue
    }
    for (const item of part.output.results as SearchResultItem[]) {
      if (item && typeof item === 'object') {
        out.push({ type: part.type, item })
      }
    }
  }
  return out
}

function isPageText(entry: CitableIndexEntry): boolean {
  // A failed fetch's placeholder is a note, not the page.
  if (!isCitableResult(entry.item)) return false
  if (entry.type !== 'tool-search') return true
  return (entry.item.content ?? '').length > SNIPPET_MAX_CHARS
}

/**
 * The page text THIS message read for `url`: the longest fetched page or
 * crawled search result with the same samePageKey. Undefined when the message
 * only ever saw a snippet of it. Message-scoped like every other resolution
 * here — another turn's fetch is never consulted.
 *
 * Rendering does not use this: the chip still links the cited result's own
 * URL and its hover still shows that result's snippet. It is the evidence a
 * support check (the telemetry below, an offline judge) should read for a
 * snippet citation.
 */
export function findPageTextForUrl(
  url: string,
  message: { parts?: unknown[] | null }
): SearchResultItem | undefined {
  const key = samePageKey(url)
  if (!key) return undefined
  let best: SearchResultItem | undefined
  for (const entry of citableResults(message)) {
    if (!isPageText(entry) || samePageKey(entry.item.url) !== key) continue
    if ((entry.item.content ?? '').length > (best?.content ?? '').length) {
      best = entry.item
    }
  }
  return best
}

export interface CitationEvidenceAudit {
  /** Rendered anchors whose cited result is itself page text. */
  page: number
  /** Rendered anchors on a snippet whose page this message read in full. */
  snippetRead: number
  /** Rendered anchors on a snippet nothing in this message read beyond. */
  snippet: number
  /**
   * Pages this message fetched (failed placeholders excluded) that no
   * rendered anchor points to, directly or through a same-page snippet
   * citation. A turn that fetched pages, cited none of them and cited
   * snippets instead is the shape of "read in a page, cited to a snippet".
   */
  fetchedPagesUncited: number
}

/**
 * Classify every RENDERED anchor of one finished assistant message by the
 * evidence behind it (CitationEvidence), with the same resolution rendering
 * uses (resolveCitationAnchor). Unresolved anchors are not counted — they
 * render nothing; auditCitations counts them.
 *
 * Why: a citation to a 400-char search snippet looks the same as one to a
 * fetched page in every other counter, yet the 2026-09-30 re-test found
 * snippet-backed citations 71% unsupported by their stored text. Re-judged
 * one by one (2026-10-01, 68 of them, against the cited page fetched live and
 * every other page of the turn): 28% were right for the reader (the snippet,
 * the same page read under another URL, or the live cited page supports the
 * claim), 32% were the wrong page (another page the turn read supports it,
 * the cited one does not), 40% were supported by nothing retrieved. So
 * `snippet` is the share of citations the stored evidence cannot vouch for,
 * `snippetRead` the share it can after all, and `fetchedPagesUncited` the
 * pages read but credited to nothing.
 */
export function auditCitationEvidence(message: {
  parts?: unknown[] | null
}): CitationEvidenceAudit {
  const audit: CitationEvidenceAudit = {
    page: 0,
    snippetRead: 0,
    snippet: 0,
    fetchedPagesUncited: 0
  }
  const index = citableResults(message)
  if (index.length === 0) return audit
  const typeOf = new Map<SearchResultItem, CitableIndexEntry>()
  // Pages this message read in full, by samePageKey (findPageTextForUrl's
  // test, computed once instead of per anchor).
  const readPages = new Set<string>()
  for (const entry of index) {
    typeOf.set(entry.item, entry)
    const key = isPageText(entry) ? samePageKey(entry.item.url) : null
    if (key) readPages.add(key)
  }
  const maps = extractCitationMaps(message as UIMessage)
  const citedPages = new Set<string>()

  for (const raw of message?.parts ?? []) {
    const part = raw as { type?: string; text?: unknown } | null
    if (part?.type !== 'text' || typeof part.text !== 'string') continue
    for (const match of part.text.matchAll(CITATION_ANCHOR_RE)) {
      const resolution = resolveCitationAnchor(
        parseInt(match[1], 10),
        match[2],
        maps
      )
      if (resolution.status === 'unresolved') continue
      const source = resolution.source
      // The resolved item is the very object in the part's results
      // (extractCitationMaps indexes them by reference); a legacy output
      // resolving through its own citationMap is matched by URL instead.
      const entry =
        typeOf.get(source) ?? index.find(e => e.item.url === source.url)
      const key = samePageKey(source.url)
      if (key) citedPages.add(key)
      if (!entry || isPageText(entry)) {
        audit.page++
      } else if (key && readPages.has(key)) {
        audit.snippetRead++
      } else {
        audit.snippet++
      }
    }
  }

  const fetched = new Set<string>()
  for (const entry of index) {
    if (entry.type !== 'tool-fetch' || !isPageText(entry)) continue
    const key = samePageKey(entry.item.url)
    if (key) fetched.add(key)
  }
  for (const key of fetched)
    if (!citedPages.has(key)) audit.fetchedPagesUncited++
  return audit
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
