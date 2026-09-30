import { stripNarrationPreamble } from '../streaming/helpers/strip-narration-preamble'

/** A part as seen by both the live path (UIMessage) and the backfill (DB rows). */
export interface IndexablePart {
  type: string
  text: string | null
  /**
   * A tool part's call id (UIMessage `toolCallId`, DB `tool_tool_call_id`).
   * Only these ids — the message's OWN tool calls — are stripped when the
   * answer text mentions them bare; see BARE_TOOL_CALL_ID_RE.
   */
  toolCallId?: string | null
}

// Citation markers the researcher emits inline, e.g. `[1](#selfhosting.sh)`
// or `[2](#c0bd1e3a-4caa-4682-bc1e-6f2cd0c7371c)` — a numeric label pointing
// at a `#`-anchored source id, not a real URL. These dilute the embedding
// without adding meaning, so they're stripped before indexing. Deliberately
// narrow: an ordinary markdown link like `[docs](https://example.com)` does
// NOT match (its label isn't purely digits and its target isn't a `#`
// anchor), so genuine links in the answer are left intact.
const CITATION_MARKER_RE = /\[\d+\]\(#[^)]*\)/g

// BARE tool call ids, e.g. `2ee2fc5b-5ca8-4f26-a149-d3f22358333d`, written into
// the answer text as prose rather than inside a citation marker. Observed
// verbatim in a persisted answer:
//
//   "So Fossies is [3] for search 1 ID `2ee2fc5b-5ca8-4f26-a149-d3f22358333d`."
//
// CITATION_MARKER_RE above does not touch these — they are not in `[N](#id)`
// form — so they survived into conversation_chunks. Conversation recall then
// injected that text into a LATER, unrelated chat, where the model saw what
// looked like a live tool call id and cited it. Confirmed on lab: a turn cited
// an id belonging to a message in a different chat, and every one of its
// citations was dropped as unresolvable. Contaminated chunks at the time of the
// fix: lab 8, staging 12, prod 13.
//
// An id is only meaningful inside the turn that produced it, so it carries no
// value for a future retrieval either — stripping costs nothing.
//
// But not every UUID in an answer is a tool call id. Stripping them all also
// removed real content from recall (prod): a Hyper-V VMCreatorId
// (`{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}`, hbTHdUV8uzmsmVYK) and the UUID
// inside image URLs (`/uploads/asset/file/44dbbd2f-…/openclaw_1_.png`,
// UfGktMa6H0CGZILT). Measured across every stored assistant text part on
// prod/staging/lab (2026-09-29): outside `[N](#id)` markers there were 33
// UUID occurrences; 32 were such content and one was a tool call id — the
// message's OWN ("It had toolCallId a4bb7072-…", staging GaGnrp44o1OQDL0r),
// the same shape as the incident above ("search 1 ID …"). So a UUID is
// stripped only when it is
//   - one of the message's own tool call ids (`IndexablePart.toolCallId`), or
//   - in citation-anchor position (`#<uuid>`) — a malformed or non-numeric
//     citation (`(#id)`, `[src](#id)`) that CITATION_MARKER_RE does not match,
//     which may point at another turn's tool call.
// Any other UUID is content and is indexed.
const BARE_TOOL_CALL_ID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function stripToolCallIds(text: string, ownIds: ReadonlySet<string>): string {
  return text.replace(BARE_TOOL_CALL_ID_RE, (id: string, offset: number) =>
    ownIds.has(id.toLowerCase()) || text[offset - 1] === '#' ? '' : id
  )
}

/** The message's own tool call ids, lowercased. */
function toolCallIdsOf(parts: IndexablePart[]): Set<string> {
  const ids = new Set<string>()
  for (const p of parts) {
    if (typeof p.toolCallId === 'string' && p.toolCallId) {
      ids.add(p.toolCallId.toLowerCase())
    }
  }
  return ids
}

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
 *   Exception: a tool call can TRAIL the answer — the generative-UI
 *   `tool-dynamic` (follow-up questions) is emitted after the answer text —
 *   leaving no text after the last tool and silently dropping the whole
 *   answer from the index (live prod data had exactly this shape: a 2,498
 *   char answer indexed as nothing). That case is indistinguishable by
 *   position from "narration, then a tool call, and no answer", since both
 *   end in a tool part, so it is resolved by the First-token rule instead —
 *   see the fallback below.
 *
 * Note: if narration text appears again after the last tool call (rare —
 * e.g. a trailing "Here's what I found:" before the real answer part), it
 * is indistinguishable from the answer by position alone and is included
 * along with it; we cannot reliably tell them apart once both are past the
 * last tool call, and the final step's text is, by construction, the answer.
 */
export function extractIndexableText(
  role: 'user' | 'assistant',
  rawParts: IndexablePart[]
): string {
  if (!Array.isArray(rawParts) || rawParts.length === 0) return ''

  // The backfill reads raw DB rows, and answers saved before a narration rule
  // existed can carry a preamble glued to their `## ` heading (D20). Cut it
  // first, so it is neither indexed nor able to hide the heading the
  // First-token fallback below looks for. Idempotent on the live path, which
  // already passes the persist-cleaned message.
  const parts =
    role === 'assistant'
      ? rawParts.map(p =>
          p.type === 'text' && typeof p.text === 'string'
            ? { ...p, text: stripNarrationPreamble(p.text) }
            : p
        )
      : rawParts

  let relevant = parts
  if (role === 'assistant') {
    let lastToolIndex = -1
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type.startsWith('tool-')) lastToolIndex = i
    }
    if (lastToolIndex !== -1) {
      relevant = parts.slice(lastToolIndex + 1)

      // Nothing after the last tool call. Two different shapes land here and
      // position cannot tell them apart — both end in a tool part:
      //   (a) narration, then a tool call, and the turn produced no answer
      //       -> index nothing, which is what `relevant` already gives us;
      //   (b) the real answer, then a tool call TRAILING it (the
      //       generative-UI tool-dynamic that renders follow-up questions is
      //       emitted after the answer text) -> the answer must be indexed,
      //       and slicing past it silently dropped the whole message.
      // Fall back to the First-token rule every mode's prompt enforces and
      // render-message.tsx already relies on: the final answer starts with a
      // markdown heading, and nothing else may. So a heading here means (b).
      if (textOf(relevant).length === 0) {
        const texts = textOf(parts)
        const last = texts[texts.length - 1]
        if (last !== undefined && /^#{1,6}\s/.test(last.trimStart())) {
          relevant = [{ type: 'text', text: last }]
        }
      }
    }
  }

  const selected = textOf(relevant)
  if (selected.length === 0) return ''

  const joined = selected.join('\n\n').replace(CITATION_MARKER_RE, '')
  return collapseWhitespace(stripToolCallIds(joined, toolCallIdsOf(rawParts)))
}
