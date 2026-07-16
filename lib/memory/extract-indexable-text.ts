/** A part as seen by both the live path (UIMessage) and the backfill (DB rows). */
export interface IndexablePart {
  type: string
  text: string | null
}

// Citation markers the researcher emits inline, e.g. `[1](#selfhosting.sh)`
// or `[2](#c0bd1e3a-4caa-4682-bc1e-6f2cd0c7371c)` — a numeric label pointing
// at a `#`-anchored source id, not a real URL. These dilute the embedding
// without adding meaning, so they're stripped before indexing. Deliberately
// narrow: an ordinary markdown link like `[docs](https://example.com)` does
// NOT match (its label isn't purely digits and its target isn't a `#`
// anchor), so genuine links in the answer are left intact.
const CITATION_MARKER_RE = /\[\d+\]\(#[^)]*\)/g

function textOf(parts: IndexablePart[]): string[] {
  return parts
    .filter(
      (p): p is IndexablePart & { text: string } =>
        p.type === 'text' && typeof p.text === 'string'
    )
    .map(p => p.text)
}

/** Collapse whitespace runs left over after citation stripping, without
 * flattening the answer's markdown structure: horizontal whitespace runs
 * (spaces/tabs) collapse to one space, and 3+ newlines collapse to a single
 * paragraph break. */
function collapseWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Picks the text that should actually be indexed for conversation recall,
 * out of a message's ordered parts.
 *
 * - `user`: a question is normally a single text part, but join all of them
 *   in case there are more.
 * - `assistant`: the researcher is a multi-step ToolLoopAgent that narrates
 *   between steps ("Let me fetch a couple more sources...") as ordinary text
 *   parts. Only the text parts that appear AFTER the last tool-call part are
 *   the final answer; everything before it is process narration, not
 *   content. If there is no tool part at all (a no-search turn), every text
 *   part is the answer.
 *
 * Note: if narration text appears again after the last tool call (rare —
 * e.g. a trailing "Here's what I found:" before the real answer part), it
 * is indistinguishable from the answer by position alone and is included
 * along with it; we cannot reliably tell them apart once both are past the
 * last tool call, and the final step's text is, by construction, the answer.
 */
export function extractIndexableText(
  role: 'user' | 'assistant',
  parts: IndexablePart[]
): string {
  if (!Array.isArray(parts) || parts.length === 0) return ''

  let relevant = parts
  if (role === 'assistant') {
    let lastToolIndex = -1
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type.startsWith('tool-')) lastToolIndex = i
    }
    if (lastToolIndex !== -1) relevant = parts.slice(lastToolIndex + 1)
  }

  const selected = textOf(relevant)
  if (selected.length === 0) return ''

  const joined = selected.join('\n\n').replace(CITATION_MARKER_RE, '')
  return collapseWhitespace(joined)
}
