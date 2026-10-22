// A chat's public link: making the chat public (anyone with the link can read
// it) and private again, through Ask's share routes
// (app/api/chats/[chatId]/share). Both work in anonymous mode too.

import type { ApiClient } from '@/core/api/client'

export type ChatVisibility = 'public' | 'private'

/** How long a Copy reads "Copied" after a copy. */
export const COPIED_MS = 1500
export const SHARE_LINK_ERROR = 'Couldn’t share the link.'

/** An error's message, or the rejection itself as text. */
export const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

type ShareResponse = { url?: unknown }

const sharePath = (id: string) => `/api/chats/${encodeURIComponent(id)}/share`

/** Makes the chat public and resolves with its link. Safe to repeat. */
export async function shareChat(
  client: ApiClient,
  id: string
): Promise<string> {
  const { url } = await client.json<ShareResponse>(sharePath(id), {
    method: 'POST'
  })
  if (typeof url !== 'string' || !url) {
    throw new Error('The server sent no link.')
  }
  return url
}

/** Makes the chat private again; its link stops working. Safe to repeat. */
export async function unshareChat(
  client: ApiClient,
  id: string
): Promise<void> {
  await client.json(sharePath(id), { method: 'DELETE' })
}

/** The share sheet rejects with "Share canceled" when the user dismisses it. */
const CANCELLED_RE = /cancel/i

/** Whether a share-sheet rejection is only the user dismissing it. */
export function isShareCancelled(error: unknown): boolean {
  return CANCELLED_RE.test(
    error instanceof Error ? error.message : String(error)
  )
}
