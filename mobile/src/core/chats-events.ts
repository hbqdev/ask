// A tiny in-memory bus that says "the user's chat list changed", so a screen
// showing the list (the Library) can reload it after another screen created,
// updated, deleted or cleared chats. Nothing is persisted.

export type ChatsChangedReason = 'created' | 'updated' | 'deleted' | 'cleared'

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
