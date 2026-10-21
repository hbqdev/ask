// A tiny in-memory bus that says "the user's chat list changed", so a screen
// showing the list (the Library) can follow changes made on another screen:
// a created or cleared list is reloaded; a chat updated, renamed, deleted or
// viewed is changed in place, so the pages already loaded stay. Nothing is
// persisted.

/**
 * - 'created': a new chat exists; 'cleared': every chat was deleted.
 * - 'updated': a turn of the chat ended (its lastViewedAt is now).
 * - 'renamed': the chat has a new title, given as `detail.title`.
 * - 'deleted': the chat is gone on the server.
 * - 'viewed': the chat was opened (its lastViewedAt is now).
 */
export type ChatsChangedReason =
  | 'created'
  | 'updated'
  | 'renamed'
  | 'deleted'
  | 'cleared'
  | 'viewed'

export type ChatsChangedDetail = { title?: string }

export type ChatsChangedListener = (
  reason: ChatsChangedReason,
  chatId?: string,
  detail?: ChatsChangedDetail
) => void

const listeners = new Set<ChatsChangedListener>()

/** Tells every subscriber; one that throws does not stop the others. */
export function emitChatsChanged(
  ...change: Parameters<ChatsChangedListener>
): void {
  for (const listener of [...listeners]) {
    try {
      listener(...change)
    } catch (error) {
      console.error('A chats-changed listener failed', error)
    }
  }
}

/** Subscribes `fn`; returns the unsubscribe. */
export function onChatsChanged(fn: ChatsChangedListener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
