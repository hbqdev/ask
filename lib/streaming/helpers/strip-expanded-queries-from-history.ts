import type { UIMessage } from 'ai'

/**
 * Removes `expandedQueries` from search tool outputs before the history is
 * converted to model messages.
 *
 * The field lists the expansion variants the turn's first search also ran; it
 * is display-only (the search card's "Also searched" list). The search tool's
 * toModelOutput strips it from the live call, but history is converted
 * without the tools map, so convertToModelMessages replays prior tool outputs
 * raw — and pruneMessages keeps the previous turn's tool calls. Without this,
 * the model would read the variants on the next turn.
 *
 * Only that one field changes, on every assistant message (a trailing one is a
 * continued turn whose outputs are replayed the same way). The persisted/UI
 * messages are not mutated; unchanged messages come back by identity.
 */
export function stripExpandedQueriesFromHistory<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.map(msg => {
    if (msg.role !== 'assistant' || !msg.parts) return msg

    let changed = false
    const parts = msg.parts.map(part => {
      if (part.type !== 'tool-search') return part
      const output = (part as { output?: unknown }).output
      if (
        output === null ||
        typeof output !== 'object' ||
        !('expandedQueries' in output)
      ) {
        return part
      }
      const { expandedQueries: _displayOnly, ...rest } = output as Record<
        string,
        unknown
      >
      changed = true
      return { ...part, output: rest }
    })
    return changed ? { ...msg, parts } : msg
  })
}
