// Identifying fields for the [latency:search] line.
//
// Without a chat id a search cannot be joined to the turn that caused it, and
// ordering does not substitute: turns make multiple searches (measured at 5
// and 7 tool calls on two turns of a single conversation), so correlating by
// position silently mismatches rows. That blocked the intent-vs-crawl-cost
// analysis and produced a table that looked plausible and was wrong.

export function buildSearchTelemetryTag(input: { chatId?: string | null }): {
  chatId?: string
} {
  const raw = input.chatId
  if (typeof raw !== 'string') return {}
  const chatId = raw.trim()
  return chatId ? { chatId } : {}
}
