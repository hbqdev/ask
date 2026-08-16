import type { AssistantModelMessage, ToolModelMessage } from 'ai'
import { createHash } from 'node:crypto'

import type { SearchResultImage, SearchResultItem } from '@/lib/types'

/**
 * Pure, side-effect-free builders that shape a set of ranked document/URL
 * chunks into the citable `documentRetrieval` artifacts the streaming layer
 * (Task 5) writes and injects. NOTHING here performs I/O or touches a stream —
 * every function returns a plain object so it is fully unit-testable.
 *
 * The feature: an attached document (or fetched URL) is retrieved for the model
 * up-front, then handed to it as a synthetic `documentRetrieval` tool call whose
 * results the model may cite exactly like a `search`/`fetch` result from this
 * turn. See Task 1's SPIKE report for the end-to-end proof. Three artifacts must
 * agree on the SAME `toolCallId`, `query`, and `results`:
 *
 *   1. the UI stream chunks (`tool-input-available` + `tool-output-available`)
 *      the client reduces into a static `tool-documentRetrieval` part — this is
 *      what drives `extractCitationMaps` / `processCitations` client-side;
 *   2. the assembled UI part itself (what the client ends up with, and what is
 *      persisted in the assistant row) — used here for typing/tests;
 *   3. the `ModelMessage` pair (assistant `tool-call` + `tool` `tool-result`)
 *      appended to `modelMessages` so the MODEL sees the real, citable id.
 *
 * `buildDocumentRetrievalArtifacts` composes all three from one input so they
 * cannot drift apart.
 */

/** The tool name the synthetic retrieval part is published under. */
export const DOCUMENT_RETRIEVAL_TOOL_NAME = 'documentRetrieval' as const

/**
 * The `output` payload shared by the UI part and the UI `tool-output-available`
 * chunk. Structurally identical to a `search`/`fetch` output (`{ state, query,
 * images, results }`) so `extractCitationMaps` derives the citation map by index
 * with zero special-casing.
 */
export interface DocumentRetrievalOutput {
  state: 'complete'
  query: string
  images: SearchResultImage[]
  results: SearchResultItem[]
}

/** The raw `tool-input-available` chunk handed to `writer.write(...)`. */
export interface DocumentRetrievalInputChunk {
  type: 'tool-input-available'
  toolCallId: string
  toolName: typeof DOCUMENT_RETRIEVAL_TOOL_NAME
  input: { query: string }
}

/** The raw `tool-output-available` chunk handed to `writer.write(...)`. */
export interface DocumentRetrievalOutputChunk {
  type: 'tool-output-available'
  toolCallId: string
  output: DocumentRetrievalOutput
}

/**
 * The assembled, static `tool-documentRetrieval` UI part — the shape the SDK
 * reducer builds from the two chunks above and that gets persisted. No
 * `dynamic` flag is involved: omitting it is what makes the reducer build a
 * STATIC `tool-<name>` part (see Task 1's report).
 */
export interface DocumentRetrievalPart {
  type: 'tool-documentRetrieval'
  toolCallId: string
  state: 'output-available'
  input: { query: string }
  output: DocumentRetrievalOutput
}

/** Input accepted by every builder in this module. */
export interface DocumentRetrievalInput {
  /** The fixed, UUID-shaped citable id (see {@link documentSourceId}). */
  sourceId: string
  /** Human title shown for every excerpt of this source. */
  title: string
  /** ABSOLUTE base URL of the source (see {@link buildDocumentResults}). */
  url: string
  /** Ranked excerpt texts, best first. Empty → nothing to cite. */
  chunks: string[]
  /** The retrieval query, if any. Defaults to `''`. */
  query?: string
}

/** Everything Task 5 needs, guaranteed to share one id / query / result set. */
export interface DocumentRetrievalArtifacts {
  toolCallId: string
  /** The assembled UI part (for typing / persistence assertions). */
  part: DocumentRetrievalPart
  /** `[inputChunk, outputChunk]` — write both to the UI stream, in order. */
  streamChunks: [DocumentRetrievalInputChunk, DocumentRetrievalOutputChunk]
  /** `[assistant tool-call, tool tool-result]` — push both onto modelMessages. */
  modelMessages: [AssistantModelMessage, ToolModelMessage]
}

/**
 * Deterministic, UUID-shaped citable id for one source.
 *
 * The search-mode prompt tells the model a real `toolCallId` "is a 36-character
 * UUID with four hyphens", and silently discards any anchor that is not shaped
 * like one — so a readable slug (`doc-<fileId>`) would be rejected on shape
 * grounds even though the machinery would resolve it. We therefore hash
 * `${kind}:${key}` and format the digest as an `8-4-4-4-12` hex UUID: stable per
 * source, 36 chars, exactly four hyphens.
 *
 * @param kind `'doc'` for an uploaded file, `'url'` for a fetched URL.
 * @param key  the stable source key (file id / absolute URL).
 */
export function documentSourceId(kind: 'doc' | 'url', key: string): string {
  const hex = createHash('sha1').update(`${kind}:${key}`).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

/**
 * One `{ title, url, content }` result per chunk, in order.
 *
 * CONTRACT: `url` MUST be an ABSOLUTE URL. `processCitations` runs each result
 * url through `new URL(...)`, which throws on a relative path (e.g.
 * `/uploads/…`) and causes the citation to be silently stripped — so a relative
 * `url` here is a defect, not a fallback. We validate up-front and throw a clear
 * error rather than emit an uncitable result.
 *
 * Each excerpt gets a distinct `#chunk-N` (1-based) fragment appended to the
 * base url so the excerpts are individually addressable and do not collapse into
 * a single source when cited (mirrors the SPIKE's fixtures).
 */
export function buildDocumentResults(
  title: string,
  url: string,
  chunks: string[]
): SearchResultItem[] {
  let base: URL
  try {
    base = new URL(url)
  } catch {
    throw new Error(
      `buildDocumentResults requires an absolute URL for citations, got: ${url}`
    )
  }

  return chunks.map((content, index) => {
    base.hash = `chunk-${index + 1}`
    return { title, url: base.toString(), content }
  })
}

/** Normalize the optional query to the `''` default the shapes use. */
function normalizeQuery(query?: string): string {
  return query ?? ''
}

/**
 * The two raw UI-message chunks to `writer.write(...)`, in order. NO `dynamic`
 * flag → the client reducer assembles a static `tool-documentRetrieval` part.
 */
export function buildDocumentRetrievalStreamChunks(
  input: DocumentRetrievalInput
): [DocumentRetrievalInputChunk, DocumentRetrievalOutputChunk] {
  const query = normalizeQuery(input.query)
  const results = buildDocumentResults(input.title, input.url, input.chunks)
  return [
    {
      type: 'tool-input-available',
      toolCallId: input.sourceId,
      toolName: DOCUMENT_RETRIEVAL_TOOL_NAME,
      input: { query }
    },
    {
      type: 'tool-output-available',
      toolCallId: input.sourceId,
      output: { state: 'complete', query, images: [], results }
    }
  ]
}

/**
 * The assistant `tool-call` + `tool` `tool-result` pair (AI SDK v6
 * `ModelMessage` shapes) appended to `modelMessages` AFTER prune/truncate so the
 * MODEL sees the citable id. Same `toolCallId` on both, `output` as a `json`
 * tool result carrying `{ state: 'complete', results }`.
 */
export function buildDocumentRetrievalModelMessages(
  input: DocumentRetrievalInput
): [AssistantModelMessage, ToolModelMessage] {
  const query = normalizeQuery(input.query)
  const results = buildDocumentResults(input.title, input.url, input.chunks)
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: input.sourceId,
          toolName: DOCUMENT_RETRIEVAL_TOOL_NAME,
          input: { query }
        }
      ]
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: input.sourceId,
          toolName: DOCUMENT_RETRIEVAL_TOOL_NAME,
          output: { type: 'json', value: { state: 'complete', results } }
        }
      ]
    }
  ]
}

/**
 * The assembled, static `tool-documentRetrieval` UI part — one
 * `{ title, url, content }` per chunk, in order. Returns `null` when there is
 * nothing to cite (`chunks` empty), so callers can skip the whole injection.
 */
export function buildDocumentRetrievalPart(
  input: DocumentRetrievalInput
): DocumentRetrievalPart | null {
  if (input.chunks.length === 0) return null
  const query = normalizeQuery(input.query)
  const results = buildDocumentResults(input.title, input.url, input.chunks)
  return {
    type: 'tool-documentRetrieval',
    toolCallId: input.sourceId,
    state: 'output-available',
    input: { query },
    output: { state: 'complete', query, images: [], results }
  }
}

/**
 * TOP-LEVEL SHAPER. Builds the UI part, the stream chunks, and the model-message
 * pair from one input so all three are guaranteed to share the same id, query,
 * and results. Returns `null` when `chunks` is empty (nothing to cite) — the
 * signal for Task 5 to inject nothing at all.
 */
export function buildDocumentRetrievalArtifacts(
  input: DocumentRetrievalInput
): DocumentRetrievalArtifacts | null {
  const part = buildDocumentRetrievalPart(input)
  if (!part) return null
  return {
    toolCallId: input.sourceId,
    part,
    streamChunks: buildDocumentRetrievalStreamChunks(input),
    modelMessages: buildDocumentRetrievalModelMessages(input)
  }
}
