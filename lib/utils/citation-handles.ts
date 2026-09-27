import { isCitableResult, MAX_CITATION_NUMBER } from './citation'

/**
 * CITATION_HANDLES — every citable result the answering model sees carries its
 * own ready-made citation string, `cite: "[N](#<toolCallId>)"`, and the prompts
 * tell the model to copy it instead of working the number out.
 *
 * Why. The renderer resolves `[N](#id)` to result N (1-based position in that
 * call's `results`) of tool call `id` (resolveCitationAnchor), but the model
 * received each call's results as a bare JSON array and had to count positions
 * itself. Models number sources as a running count across the answer instead,
 * so an in-range number renders a different page than the one the sentence
 * came from (lab 2026-09-26: 11 of 19 citations in one turn), and an
 * out-of-range one on a multi-page fetch renders nothing. Measured on the prod
 * replay: ~22 of 88 answers use the running-count pattern, ~459 anchors likely
 * render the wrong page. Handing the model the finished string removes the
 * counting.
 *
 * DEFAULT ON. Only the literal `off` disables it (the ALWAYS_SEARCH /
 * RECALL_ENABLED kill-switch convention). Off restores the previous model-facing
 * tool output and prompt text byte for byte. Read at call time, so a container
 * recreate with CITATION_HANDLES=off reverts it without a rebuild.
 */
export function isCitationHandlesEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.CITATION_HANDLES !== 'off'
}

/** The citation of result `position` of tool call `toolCallId`. */
export function formatCitationHandle(
  position: number,
  toolCallId: string
): string {
  return `[${position}](#${toolCallId})`
}

// An id both the renderer (CITATION_ANCHOR_RE, `#([^)]+)`) and the history strip
// (strip-citation-anchors-from-history.ts, `#[^)\s]+`) capture whole. Provider,
// forced-search and documentRetrieval ids all qualify; anything else gets no
// handle rather than one that would not round-trip.
const ANCHOR_SAFE_ID_RE = /^[^\s()]+$/

/**
 * A copy of a search/fetch/documentRetrieval output whose `results` each carry
 * a `cite` string that resolves, through extractCitationMaps +
 * resolveCitationAnchor, to that same result: N is the result's 1-based
 * position in THIS output's `results`, which is exactly the array
 * extractCitationMaps indexes (the final output the SDK hands toModelOutput is
 * the one the UI part stores and persistence saves).
 *
 * - Positions count every result, including ones that get no handle, so the
 *   numbering matches the renderer's.
 * - No handle for a result that would not render when cited (invalid URL,
 *   beyond MAX_CITATION_NUMBER) or that is a failed-fetch placeholder.
 * - `cite` is the first key of each result: read before the page it labels,
 *   and nothing else in the result changes.
 * - A legacy output carrying a `citationMap` resolves through that map, not by
 *   position, so it is returned untouched.
 * - Never mutates `output`; returns it as-is when there is nothing to add.
 */
export function addCitationHandles<T>(
  output: T,
  toolCallId: string | undefined
): T {
  if (!output || typeof output !== 'object') return output
  if (!toolCallId || !ANCHOR_SAFE_ID_RE.test(toolCallId)) return output
  const { results, citationMap } = output as {
    results?: unknown
    citationMap?: unknown
  }
  if (!Array.isArray(results) || results.length === 0) return output
  if (
    citationMap &&
    typeof citationMap === 'object' &&
    Object.keys(citationMap).length > 0
  ) {
    return output
  }

  let added = false
  const withHandles = results.map((item: unknown, index: number) => {
    const position = index + 1
    if (position > MAX_CITATION_NUMBER || !isCitableResult(item)) return item
    added = true
    const { cite: _previous, ...rest } = item as Record<string, unknown>
    return { cite: formatCitationHandle(position, toolCallId), ...rest }
  })
  return added ? { ...output, results: withHandles } : output
}
