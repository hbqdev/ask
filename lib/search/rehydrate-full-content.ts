import type { UIMessage } from 'ai'

import type { SearchResultItem } from '@/lib/types'

// Swaps excerpted search output for full crawled text just before persistence.
//
// A tool result serves two roles: what the model reads on the turn that
// produced it, and what is replayed as conversation history afterwards.
// pruneMessages keeps tool results for the immediately-following turn
// (create-chat-stream-response.ts), and that is exactly the turn that regressed
// when per-source content shrank: balanced answered a follow-up from context
// with 0 tools in 9.2s, while thin-content arms searched again (3 tools/61.1s
// with speed mode, 5 tools/107.3s with excerpts).
//
// Persisting the full text keeps history deep enough to answer follow-ups from,
// while the live prompt stays small.
//
// NOTE: after this runs, the persisted message is deliberately NOT
// byte-identical to what the model was shown. Citations reference toolCallIds
// and source URLs, neither of which changes — but do not assume "persisted ==
// what the model saw" anywhere downstream.

/** Keyed by toolCallId. A missing entry means "persist as-is". */
export type FullContentByToolCall = Map<string, SearchResultItem[]>

export function rehydrateFullContent(
  message: UIMessage,
  fullByToolCall: FullContentByToolCall
): UIMessage {
  if (fullByToolCall.size === 0) return message

  const parts = (message.parts as unknown[]).map(part => {
    try {
      const p = part as {
        type?: string
        toolCallId?: string
        output?: Record<string, unknown>
      } | null
      if (!p || p.type !== 'tool-search' || !p.toolCallId || !p.output) {
        return part
      }
      const full = fullByToolCall.get(p.toolCallId)
      if (!full) return part
      return { ...p, output: { ...p.output, results: full } }
    } catch {
      // Persistence must never be broken by this.
      return part
    }
  })

  return { ...message, parts } as UIMessage
}
