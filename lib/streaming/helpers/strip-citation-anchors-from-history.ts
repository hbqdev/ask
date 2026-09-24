import type { UIMessage } from 'ai'

// `[N](#toolCallId)` — the only anchor form processCitations acts on.
const ANCHOR_RE = /[ \t]*\[\s*\d+\s*\]\(#[^)\s]+\)/g

/**
 * Remove citation anchors from PRIOR assistant turns before they are sent to
 * the model as conversation history.
 *
 * A citation is only valid against a tool call the SAME turn made (rendering
 * scopes citation maps per message). But history still carried every earlier
 * answer's `[N](#<old toolCallId>)` anchors verbatim, while pruneMessages
 * (toolCalls: 'before-last-2-messages') drops those turns' actual tool calls and
 * results. So the old ids were in context with nothing behind them, and models
 * copied them into the new answer — either the exact earlier anchor or a new
 * number on an old id — which then renders as nothing. On prod this was the
 * largest unresolved class in the recent sample (70 of 158 unresolved anchors
 * in the 11 flagged turns; 146 of 655 across all history), and it is the whole
 * story for follow-up turns that ran no search (all anchors unresolved).
 *
 * The answer text itself is untouched (persisted/rendered copies keep their
 * anchors); only the model's view of history changes. A trailing assistant
 * message is left alone: that is the turn being continued (e.g. after a tool
 * approval), whose anchors are its own.
 */
export function stripCitationAnchorsFromHistory<T extends UIMessage>(
  messages: T[]
): T[] {
  const lastIndex = messages.length - 1
  return messages.map((msg, index) => {
    if (msg.role !== 'assistant' || !msg.parts) return msg
    if (index === lastIndex) return msg

    let changed = false
    const parts = msg.parts.map(part => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const stripped = part.text.replace(ANCHOR_RE, '')
      if (stripped === part.text) return part
      changed = true
      return { ...part, text: stripped }
    })
    return changed ? { ...msg, parts } : msg
  })
}
