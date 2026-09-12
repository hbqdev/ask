// Token-budget the injected documentRetrieval sources so the excerpts appended
// AFTER prune/truncate can never push the prompt past the model's real context
// window (a provider 400 that would kill a turn that DID retrieve — see
// create-chat-stream-response.ts).
//
// The excerpts escape the truncateMessages budget because they are pushed onto
// modelMessages afterwards, and each source's chunks are only count-capped
// (MAX_INJECTED_DOC_SOURCES), not size-capped: 8 sources × 10 chunks × 512-token
// chunks is ~40k tokens of content, which on a small-window model overflows on
// its own. This trims the injected chunks to whatever the window has left after
// the (already truncated) messages and an answer reserve, dropping the
// LOWEST-RANKED chunks — then whole sources — first. Chunks arrive best-first
// (cosine + cross-encoder), so a source keeps a contiguous top slice and every
// surviving chunk keeps its #chunk-N citation anchor.

import type { ModelMessage } from 'ai'

import {
  estimateMessagesTokens,
  estimateTextTokens
} from '@/lib/utils/context-window'

import type { DocumentRetrievalInput } from './document-retrieval-part'

// Structural token overhead the text estimator cannot see. The content travels
// as a tool-result whose text lives in a JSON `output` (not a `text` part), and
// buildDocumentResults repeats {title, url} on every chunk — so charge each
// surviving chunk its own text PLUS the title/url it carries PLUS a small
// allowance for the JSON keys/framing, and each source a one-time allowance for
// the assistant tool-call + query. Deliberately generous so the estimate errs
// toward UNDER-filling the window (never a 400) rather than over-filling it.
const PER_CHUNK_FRAMING_TOKENS = 12
const PER_SOURCE_FRAMING_TOKENS = 16

export interface DocBudgetResult {
  /** Surviving sources, in the input order, each trimmed to its top chunks. */
  sources: DocumentRetrievalInput[]
  /** True when any chunk or whole source was dropped to fit the window. */
  clipped: boolean
  /** Chunks dropped (across partially-trimmed AND fully-dropped sources). */
  droppedChunks: number
  /** Sources dropped entirely (every chunk trimmed away). */
  droppedSources: number
  /** The token budget the trim targeted (for telemetry). */
  budgetTokens: number
}

function chunkCost(
  chunk: string,
  titleTokens: number,
  urlTokens: number,
  modelId?: string
): number {
  return (
    estimateTextTokens(chunk, modelId) +
    titleTokens +
    urlTokens +
    PER_CHUNK_FRAMING_TOKENS
  )
}

/**
 * Trim injected document/URL sources so their combined token cost fits the room
 * left in the model's real context window.
 *
 * @param sources        deduped + count-capped sources, ordered oldest→newest
 *                       (history docs first, this turn's URLs last).
 * @param currentMessages the post-truncate model messages the docs are appended
 *                        to (sized with the SAME estimator truncation used).
 * @param maxInputTokens getMaxAllowedTokens(model, contextWindow) — the SAME
 *                        budget truncateMessages targeted (it already reserves
 *                        output tokens + a safety buffer). `null` = unknown
 *                        window; nothing is trimmed (mirrors truncation).
 * @param hardCapTokens  optional extra cap on the doc budget. `undefined` =
 *                        derive purely from the window; a positive number caps
 *                        it lower; `0` disables the clip entirely (inject all).
 */
export function budgetDocumentSources(
  sources: DocumentRetrievalInput[],
  currentMessages: ModelMessage[],
  maxInputTokens: number | null,
  modelId?: string,
  hardCapTokens?: number
): DocBudgetResult {
  const passthrough: DocBudgetResult = {
    sources,
    clipped: false,
    droppedChunks: 0,
    droppedSources: 0,
    budgetTokens: 0
  }

  // Nothing to trim, clip disabled (hardCap 0), or an unknown window
  // (maxInputTokens null — truncateMessages likewise skips): inject as-is.
  if (sources.length === 0 || hardCapTokens === 0 || maxInputTokens === null) {
    return passthrough
  }

  const used = estimateMessagesTokens(currentMessages, modelId)
  let budget = maxInputTokens - used
  if (hardCapTokens !== undefined) budget = Math.min(budget, hardCapTokens)
  const budgetTokens = Math.max(budget, 0)

  // Fund the newest sources first: the array is oldest→newest and the count cap
  // already kept the newest, so this biases the surviving budget toward the
  // most-relevant-to-this-turn sources (recent docs + this turn's URLs). Within
  // a source, fund chunks best-first, so the lowest-ranked chunks fall off the
  // end and the survivors stay a contiguous top slice.
  const kept: number[] = new Array(sources.length).fill(0)
  let remaining = budgetTokens
  for (let i = sources.length - 1; i >= 0; i--) {
    const src = sources[i]
    const titleTokens = estimateTextTokens(src.title, modelId)
    const urlTokens = estimateTextTokens(src.url, modelId)
    for (let c = 0; c < src.chunks.length; c++) {
      const cost =
        chunkCost(src.chunks[c], titleTokens, urlTokens, modelId) +
        (kept[i] === 0 ? PER_SOURCE_FRAMING_TOKENS : 0)
      if (cost <= remaining) {
        remaining -= cost
        kept[i] += 1
      } else {
        // Stop this source — never keep a lower-ranked chunk once a
        // higher-ranked one was dropped — but keep scanning: a later (newer)
        // source with a smaller top chunk may still fit.
        break
      }
    }
  }

  const outSources: DocumentRetrievalInput[] = []
  let droppedChunks = 0
  let droppedSources = 0
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    const keepN = kept[i]
    if (keepN >= src.chunks.length) {
      outSources.push(src)
      continue
    }
    droppedChunks += src.chunks.length - keepN
    if (keepN === 0) {
      droppedSources += 1
      continue
    }
    outSources.push({ ...src, chunks: src.chunks.slice(0, keepN) })
  }

  return {
    sources: outSources,
    clipped: droppedChunks > 0,
    droppedChunks,
    droppedSources,
    budgetTokens
  }
}
