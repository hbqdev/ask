// Ephemeral, per-turn RAG for a URL pasted into the chat.
// At turn time: fetch the URL's readable content (reusing the fetch tool's
// whole extraction chain) → chunk → embed → cosine + cross-encoder rank →
// return the top chunks. Nothing is persisted; retrieval is per-turn only —
// a per-chat cache is intentionally out of scope for this slice.

import type { ToolCallOptions } from 'ai'

import { fetchTool } from '@/lib/tools/fetch'

import { splitText } from './split-text'
import { embedTexts, getConfiguredModel } from './transformers-embedding'
import { rankChunks } from './upload-rag'

// Below this the body is a bot-wall stub, a JS shell, or the fetch tool's own
// "Fetch failed" placeholder — none worth grounding on. Mirrors the fetch
// chain's own MIN_CONTENT_LENGTH floor.
const MIN_MEANINGFUL_CHARS = 200

type FetchResult = { title?: string; content?: string; url?: string }

/**
 * Run the fetch tool's extraction chain for one URL and return the readable
 * body + title, or null on any miss. The tool owns SSRF guarding, the per-url
 * deadline, YouTube/PDF handling, and the Crawl4AI → FlareSolverr → Jina/Tavily
 * → Firecrawl rescue tiers, so URL grounding reuses all of it rather than
 * re-implementing any tier. Its generator is driven exactly as the researcher
 * agent drives search (lib/agents/researcher.ts).
 */
async function fetchUrlContent(
  url: string
): Promise<{ title: string; content: string } | null> {
  const executeFunc = fetchTool.execute
  if (!executeFunc) return null

  const result = executeFunc({ url, type: 'regular' }, {} as ToolCallOptions)
  const iterable =
    result &&
    typeof result === 'object' &&
    Symbol.asyncIterator in (result as object)
      ? (result as AsyncIterable<unknown>)
      : (async function* () {
          yield await result
        })()

  let best: FetchResult | undefined
  for await (const chunk of iterable) {
    const c = chunk as { state?: string; results?: FetchResult[] }
    if (
      c.state === 'complete' &&
      Array.isArray(c.results) &&
      c.results.length
    ) {
      best = c.results[0]
    }
  }

  const content = best?.content?.trim() ?? ''
  const title = best?.title ?? ''
  // The tool never throws; a total failure surfaces as a single result whose
  // title is prefixed "Fetch failed:". Treat that, and any too-short body, as
  // a miss so grounding is simply skipped rather than fed a stub.
  if (
    !content ||
    content.length < MIN_MEANINGFUL_CHARS ||
    title.startsWith('Fetch failed:')
  ) {
    return null
  }

  let fallbackTitle = title
  if (!fallbackTitle) {
    try {
      fallbackTitle = new URL(url).hostname
    } catch {
      fallbackTitle = url
    }
  }
  return { title: fallbackTitle, content }
}

/**
 * Fetch a pasted URL, chunk + embed + rank its readable content against the
 * query, and return the top-K chunk texts plus a page title. Returns null on
 * any fetch/extract failure — fail-open, because URL grounding must never
 * throw into the answer path.
 */
export async function retrieveUrlChunks(
  url: string,
  query: string,
  topK = 10
): Promise<{ chunks: string[]; title: string } | null> {
  try {
    const extracted = await fetchUrlContent(url)
    if (!extracted) return null

    // Same chunking as upload-RAG so a URL and an uploaded file are indexed
    // identically (512-token chunks, 128-token overlap).
    const chunkTexts = splitText(extracted.content, 512, 128)
    if (chunkTexts.length === 0) return null

    const model = getConfiguredModel()
    const [chunkEmbeddings, queryEmbeddings] = await Promise.all([
      embedTexts(chunkTexts, model),
      embedTexts([query], model, { kind: 'query' })
    ])

    const chunks = await rankChunks(
      query,
      chunkTexts.map((content, i) => ({
        content,
        embedding: chunkEmbeddings[i]
      })),
      queryEmbeddings[0],
      topK
    )
    if (chunks.length === 0) return null

    return { chunks, title: extracted.title }
  } catch (error) {
    console.error('[url-rag] retrieveUrlChunks failed:', error)
    return null
  }
}
