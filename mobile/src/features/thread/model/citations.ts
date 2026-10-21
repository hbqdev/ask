// An answer's citations and sources: the text the thread renders and copies,
// with [N](#toolCallId) anchors resolved to source links, and the source list
// behind them. The same pipelines as the web (components/message.tsx and
// message-actions.tsx), built on Ask's lib/utils/citation. Pure: no React.
import type { UIMessage } from 'ai'

import { stripSpecBlocks } from '@/lib/render/strip-spec-blocks'
import {
  collapseCitationArtifacts,
  extractCitationMaps,
  extractCitedSourceUrls,
  isCitableResult,
  processCitations,
  stripIncompleteCitationTail
} from '@/lib/utils/citation'

export type CitationMaps = ReturnType<typeof extractCitationMaps>

export type Source = {
  url: string
  title: string
  host: string
  snippet: string
  favicon: string
  cited: boolean
}

const SNIPPET_CHARS = 240
const SPEC_FENCE_OPEN = '```spec'

/**
 * Drop a ```spec fence the stream has opened but not yet closed: from the
 * last opening fence to the end of the text. Its JSONL would otherwise flash
 * as text until the closing fence lands and stripSpecBlocks removes it.
 */
function stripUnfinishedSpecFence(text: string): string {
  const open = text.lastIndexOf(SPEC_FENCE_OPEN)
  if (open === -1) return text
  const closed = text.includes('```', open + SPEC_FENCE_OPEN.length)
  return closed ? text : text.slice(0, open)
}

/** The answer text as the thread renders it: citations resolved, spec fences gone. */
export function renderableAnswer(text: string, maps: CitationMaps): string {
  const answer = collapseCitationArtifacts(
    processCitations(
      stripIncompleteCitationTail(stripUnfinishedSpecFence(text)),
      maps
    )
  )
  return stripSpecBlocks(answer)
}

/** The answer text as Copy puts it on the clipboard. */
export function copyableAnswer(text: string, maps: CitationMaps): string {
  return stripSpecBlocks(
    collapseCitationArtifacts(processCitations(text, maps))
  )
}

function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '')
}

/**
 * Every page the message's search, fetch and document tools returned, once
 * per URL, cited ones first. Failed fetches and unusable URLs are left out
 * (isCitableResult), as they are never citable.
 */
export function listSources(message: UIMessage): Source[] {
  const cited = new Set(extractCitedSourceUrls(message))
  const byUrl = new Map<string, Source>()
  for (const map of Object.values(extractCitationMaps(message))) {
    for (const result of Object.values(map)) {
      if (byUrl.has(result.url) || !isCitableResult(result)) continue
      const host = hostOf(result.url)
      byUrl.set(result.url, {
        url: result.url,
        title: result.title,
        host,
        snippet: (result.content ?? '').slice(0, SNIPPET_CHARS),
        favicon: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
        cited: cited.has(result.url)
      })
    }
  }
  const sources = [...byUrl.values()]
  return [...sources.filter(s => s.cited), ...sources.filter(s => !s.cited)]
}

/** A URL as the WHATWG parser writes it back, or the text itself if it is not one. */
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/**
 * The source a rendered link points at, or undefined for an ordinary link.
 * processCitations writes the href as encodeURI(url), and the markdown
 * renderer (rehype-harden) rewrites that to new URL(href).href: a bare origin
 * gains a `/`, the host is lowercased (punycode for IDN) and a default port
 * drops. So the hrefs are compared in that normalized form.
 */
export function sourceForHref(
  href: string,
  sources: Source[]
): Source | undefined {
  const exact = sources.find(s => s.url === href)
  if (exact) return exact
  const target = normalizeUrl(href)
  return sources.find(s => normalizeUrl(encodeURI(s.url)) === target)
}
