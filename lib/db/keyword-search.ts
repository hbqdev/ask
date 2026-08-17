/**
 * Pure keyword-search helpers, kept OUT of the 'use server' actions module so
 * they can be plain (non-async) exports and unit-tested without a database.
 *
 * The two indexed SQL arms live in `searchUserChatsKeyword` (lib/db/actions.ts);
 * this module owns the shared result shape, the snippet extractor, and the
 * merge that folds the arms into one deduped, recency-ordered result set.
 */

export type ChatSearchResult = {
  chatId: string
  chatTitle: string
  snippet: string // ~150 chars of context around the match
  role: string // 'user' | 'assistant'
  lastViewedAt: Date | null
}

/** A row from the CONTENT arm (matched on message text). */
export type KeywordContentRow = {
  chatId: string
  chatTitle: string
  snippet: string | null // parts.text_text of the matching part
  role: string | null // messages.role of the matching message
  lastViewedAt: Date | null
}

/** A row from the TITLE arm (matched on chat title; already one per chat). */
export type KeywordTitleRow = {
  chatId: string
  chatTitle: string
  lastViewedAt: Date | null
}

/**
 * Trim to ~150 chars of context centred on the first occurrence of `query`.
 * Falls back to a leading slice when the query isn't literally present (e.g. a
 * title-only match whose snippet derives from the title, not the query).
 */
export function extractSnippet(text: string, query: string): string {
  const MAX = 150
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text.slice(0, MAX)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, start + MAX)
  const snippet = text.slice(start, end)
  return (start > 0 ? '…' : '') + snippet + (end < text.length ? '…' : '')
}

/**
 * Fold the two indexed keyword arms into the final `ChatSearchResult[]`.
 *
 * Content-arm rows are inserted FIRST and win on collision, so a chat that
 * matched in its message text shows that matching message as the snippet; a
 * chat that matched ONLY on its title falls back to the title-arm row (snippet
 * derives from the title). Deduped by `chatId`, ordered most-recently-viewed
 * first (`lastViewedAt DESC NULLS LAST`), then capped at `limit`.
 *
 * Pure by design: the arms' index usage is proven by EXPLAIN, not here, so all
 * this needs to guard is the merge/dedup/ordering — testable without a DB.
 */
export function mergeKeywordSearchArms(
  contentRows: KeywordContentRow[],
  titleRows: KeywordTitleRow[],
  query: string,
  limit: number
): ChatSearchResult[] {
  const byChat = new Map<string, ChatSearchResult>()

  // Content arm first — its snippet is the matching MESSAGE text.
  for (const row of contentRows) {
    if (byChat.has(row.chatId)) continue
    byChat.set(row.chatId, {
      chatId: row.chatId,
      chatTitle: row.chatTitle,
      snippet: extractSnippet(row.snippet ?? row.chatTitle, query),
      role: row.role ?? 'user',
      lastViewedAt: row.lastViewedAt
    })
  }

  // Title-only matches fill in; a chat already carried by the content arm keeps
  // its message snippet.
  for (const row of titleRows) {
    if (byChat.has(row.chatId)) continue
    byChat.set(row.chatId, {
      chatId: row.chatId,
      chatTitle: row.chatTitle,
      snippet: extractSnippet(row.chatTitle, query),
      role: 'user',
      lastViewedAt: row.lastViewedAt
    })
  }

  return [...byChat.values()].sort(byLastViewedAtDesc).slice(0, limit)
}

/** Most-recently-viewed first; NULL `lastViewedAt` sorts last. */
function byLastViewedAtDesc(a: ChatSearchResult, b: ChatSearchResult): number {
  const at = a.lastViewedAt?.getTime()
  const bt = b.lastViewedAt?.getTime()
  if (at == null && bt == null) return 0
  if (at == null) return 1 // a null → after b
  if (bt == null) return -1 // b null → after a
  return bt - at // both present → descending
}
