/**
 * Search/fetch calls that were REFUSED without running, folded into one entry
 * for the research-process step list.
 *
 * THE BUG THIS FIXES. Prod chat cznh8gc1gz41vq2lwjb560br (mistral-large-4): the
 * user reported "mistral still did 18 searches", but only 5 searches ran. The
 * other calls were refused by the pipeline and returned an empty, non-error
 * result, which the UI rendered as one more ordinary search row each — so the
 * step list itself told the user they all ran.
 *
 * A refused call is recognised by the flag its refusal sets, never by notice
 * text:
 * - `searchLimitReached: true` — the per-turn search round cap
 *   (lib/tools/search.ts).
 * - `fetchLimitReached: true` — the per-turn fetch cap (lib/tools/fetch.ts).
 * - `answerNow: true` — the answer-deadline / answer-now wrapper
 *   (enforceAnswerDeadline -> answerNowResult in lib/agents/answer-deadline.ts).
 *
 * Plus one error shape: once `search` is withdrawn after the cap
 * (lib/agents/search-cap.ts), a model can invent arguments for the tool it no
 * longer sees, which the AI SDK rejects before the tool runs ("Invalid input
 * for tool search: …", stored as state 'output-error'). That counts as skipped
 * ONLY after a flagged refusal earlier in the same list — the same error with
 * no refusal before it is an ordinary failed call, not the limit, and keeps
 * rendering as the error it is.
 *
 * Deliberately NOT skipped: a near-duplicate / exact-repeat dedup result, a
 * provider error, and any call still in flight (no output yet, or the
 * streaming `searching` yield). Only a finished call can be known to be a
 * refusal, so live streaming shows a pending call as today until its result
 * arrives, then it joins the entry.
 */

export type SkippedToolCalls = {
  type: 'skipped-tool-calls'
  /** The folded calls, in stream order (also a stable React key source). */
  toolCallIds: string[]
  /** Refused `search` calls (cap, answer-now, invented-args errors). */
  searches: number
  /** Refused `fetch` calls ("page reads"). */
  fetches: number
  /** At least one search was refused by the round cap specifically. */
  searchLimitReached: boolean
}

type SkippableTool = 'search' | 'fetch'

type Refusal = 'search-limit' | 'fetch-limit' | 'answer-now' | 'invalid-input'

type PartView = {
  type?: unknown
  toolCallId?: unknown
  state?: unknown
  output?: unknown
  errorText?: unknown
}

function skippableTool(type: unknown): SkippableTool | null {
  if (type === 'tool-search') return 'search'
  if (type === 'tool-fetch') return 'fetch'
  return null
}

/** The refusal flag a finished call's output carries, if any. */
function flaggedRefusal(tool: SkippableTool, part: PartView): Refusal | null {
  if (part.state !== 'output-available') return null
  const output = part.output
  if (typeof output !== 'object' || output === null) return null
  const flags = output as {
    searchLimitReached?: unknown
    fetchLimitReached?: unknown
    answerNow?: unknown
  }
  if (tool === 'search' && flags.searchLimitReached === true) {
    return 'search-limit'
  }
  if (tool === 'fetch' && flags.fetchLimitReached === true) {
    return 'fetch-limit'
  }
  if (flags.answerNow === true) return 'answer-now'
  return null
}

/**
 * The AI SDK's InvalidToolInputError message is
 * `Invalid input for tool <name>: <cause>`; match the exact tool name so
 * `search` never matches a longer name.
 */
function isInvalidInput(tool: SkippableTool, part: PartView): boolean {
  if (part.state !== 'output-error' || typeof part.errorText !== 'string') {
    return false
  }
  const prefix = `Invalid input for tool ${tool}`
  return part.errorText === prefix || part.errorText.startsWith(`${prefix}:`)
}

/**
 * Remove every refused search/fetch call from `parts` and put ONE
 * `SkippedToolCalls` entry where the first refused call was.
 *
 * Placement at the first refusal (not the end of the list) keeps the step list
 * chronological — the entry sits right after the searches that did run, at the
 * point the limit fired — and keeps its position stable while a live turn
 * streams: later refusals only raise its count, nothing below it jumps.
 *
 * Returns `parts` itself when nothing was refused, so callers can compare by
 * identity and old turns render exactly as before.
 */
export function collapseSkippedToolCalls<T>(
  parts: readonly T[]
): readonly (T | SkippedToolCalls)[] {
  let summary: SkippedToolCalls | null = null
  const out: (T | SkippedToolCalls)[] = []

  for (const part of parts) {
    const view = (part ?? {}) as PartView
    const tool = skippableTool(view.type)
    const refusal =
      tool === null
        ? null
        : (flaggedRefusal(tool, view) ??
          // Invented-args errors only after a flagged refusal (see header).
          (summary !== null && isInvalidInput(tool, view)
            ? 'invalid-input'
            : null))

    if (tool === null || refusal === null) {
      out.push(part)
      continue
    }

    if (summary === null) {
      summary = {
        type: 'skipped-tool-calls',
        toolCallIds: [],
        searches: 0,
        fetches: 0,
        searchLimitReached: false
      }
      out.push(summary)
    }
    if (typeof view.toolCallId === 'string') {
      summary.toolCallIds.push(view.toolCallId)
    }
    if (tool === 'search') summary.searches += 1
    else summary.fetches += 1
    if (refusal === 'search-limit') summary.searchLimitReached = true
  }

  return summary === null ? parts : out
}

export function isSkippedToolCalls(part: unknown): part is SkippedToolCalls {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'skipped-tool-calls'
  )
}

/**
 * "Search limit reached — 12 extra searches skipped". The lead names the
 * search cap only when a search was actually refused by it; answer-now and
 * fetch-cap refusals read "Research limit reached".
 */
export function skippedToolCallsLabel({
  searches,
  fetches,
  searchLimitReached
}: SkippedToolCalls): string {
  const lead = searchLimitReached
    ? 'Search limit reached'
    : 'Research limit reached'
  const items: string[] = []
  if (searches > 0) {
    items.push(`${searches} extra search${searches === 1 ? '' : 'es'}`)
  }
  if (fetches > 0) {
    items.push(`${fetches} page read${fetches === 1 ? '' : 's'}`)
  }
  return `${lead} — ${items.join(' and ')} skipped`
}
