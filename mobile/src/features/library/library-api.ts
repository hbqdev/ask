// The Library's calls to Ask's chat REST routes: the paged history list,
// search, delete, rename, delete all, and the "viewed" touch. Shapes are the
// server's (app/api/chats/**), mapped to the rows the app shows.

import type { ApiClient } from '@/core/api/client'

export type ChatSort = 'recent' | 'newest' | 'oldest' | 'title'

/** One history row. `searchMode` and `fileCount` come from the page badges. */
export type ChatRow = {
  id: string
  title: string
  createdAt: string
  lastViewedAt: string | null
  searchMode?: string
  fileCount: number
}

export type ChatsPage = {
  chats: ChatRow[]
  /** The offset of the next page, or null when this was the last one. */
  nextOffset: number | null
  /** The user's real chat count; only when asked for with `withCount`. */
  total?: number
}

export type SearchHit = {
  chatId: string
  title: string
  snippet: string
  lastViewedAt: string | null
}

/** GET /api/chats as the server sends it (dates are ISO strings). */
type ChatsResponse = {
  chats: Array<{
    id: string
    title: string
    createdAt: string
    lastViewedAt: string | null
  }>
  nextOffset: number | null
  badges?: Record<string, { searchMode?: string; fileCount: number }>
  total?: number
}

type SearchResponse = {
  results: Array<{
    chatId: string
    chatTitle: string
    snippet: string
    lastViewedAt: string | null
  }>
}

const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}`

/** One page of the user's chats, in `sort` order. */
export async function fetchChatsPage(
  client: ApiClient,
  {
    offset,
    limit = 30,
    sort,
    withCount = false
  }: { offset: number; limit?: number; sort: ChatSort; withCount?: boolean }
): Promise<ChatsPage> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    sort
  })
  if (withCount) params.set('withCount', '1')
  const body = await client.json<ChatsResponse>(`/api/chats?${params}`)
  const badges = body.badges ?? {}
  const chats = body.chats.map(chat => {
    const badge = badges[chat.id]
    return {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      lastViewedAt: chat.lastViewedAt ?? null,
      ...(badge?.searchMode ? { searchMode: badge.searchMode } : {}),
      fileCount: badge?.fileCount ?? 0
    }
  })
  return typeof body.total === 'number'
    ? { chats, nextOffset: body.nextOffset, total: body.total }
    : { chats, nextOffset: body.nextOffset }
}

/**
 * Searches titles and message text (keyword). `semantic` also blends in
 * semantic recall, which costs the server an embedding and rerank round-trip.
 */
export async function searchChats(
  client: ApiClient,
  q: string,
  opts: { semantic?: boolean; signal?: AbortSignal } = {}
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q })
  if (opts.semantic) params.set('semantic', '1')
  const { results } = await client.json<SearchResponse>(
    `/api/chats/search?${params}`,
    { signal: opts.signal }
  )
  return results.map(hit => ({
    chatId: hit.chatId,
    title: hit.chatTitle,
    snippet: hit.snippet,
    lastViewedAt: hit.lastViewedAt ?? null
  }))
}

export async function deleteChat(client: ApiClient, id: string): Promise<void> {
  await client.json(chatPath(id), { method: 'DELETE' })
}

/** Renames a chat; resolves with the title as the server saved it. */
export async function renameChat(
  client: ApiClient,
  id: string,
  title: string
): Promise<string> {
  const body = await client.json<{ title: string }>(chatPath(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  })
  return body.title
}

/** Deletes every chat of the signed-in user. */
export async function clearAllChats(client: ApiClient): Promise<void> {
  await client.json('/api/chats', { method: 'DELETE' })
}

/**
 * Marks a chat as just viewed (for the `recent` sort). Best-effort: it never
 * rejects, whatever the network or server does.
 */
export async function touchChat(client: ApiClient, id: string): Promise<void> {
  try {
    await client.fetch(`${chatPath(id)}/touch`, { method: 'POST' })
  } catch {
    // A missed touch only leaves the chat lower in `recent`.
  }
}
