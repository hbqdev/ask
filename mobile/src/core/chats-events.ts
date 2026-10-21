// A tiny in-memory bus that says "the user's chat list changed", so a screen
// showing the list (the Library) can reload it after another screen created,
// updated, deleted or cleared chats, or update it in place after a chat was
// only viewed. Nothing is persisted.

/** 'viewed': a chat was opened (its lastViewedAt is now); nothing else changed. */
export type ChatsChangedReason =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'cleared'
  | 'viewed'

export type ChatsChangedListener = (
  reason: ChatsChangedReason,
  chatId?: string
) => void

const listeners = new Set<ChatsChangedListener>()

/** Tells every subscriber; one that throws does not stop the others. */
export function emitChatsChanged(
  reason: ChatsChangedReason,
  chatId?: string
): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason, chatId)
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
