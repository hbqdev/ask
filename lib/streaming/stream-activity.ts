// Client-side registry of chat turns currently in flight on this page.
//
// Invariant it exists to enforce: never router.refresh() (or otherwise refetch
// the RSC for the current route) while a turn is streaming. The refetched route
// does not contain the still-generating assistant message, so the chat blanks
// until the stream re-asserts — and for a new chat whose URL is a pushState'd
// /search/<id>, the refetch re-resolves that route mid-turn.
//
// Chat instances report their own status here (keyed per mounted instance, so
// Next.js keeping a duplicate Chat mounted can't clobber another's entry), and
// the sidebar defers its reconciling refresh until nothing is active. That
// covers refresh triggers that don't come from the streaming chat itself — a
// previous chat's turn finishing in the background after "New chat", or a
// different chat deleted from the sidebar while this one is answering.

const active = new Set<string>()
const listeners = new Set<() => void>()

export function setStreamActive(key: string, isActive: boolean): void {
  const had = active.has(key)
  if (isActive === had) return
  if (isActive) active.add(key)
  else active.delete(key)
  listeners.forEach(listener => listener())
}

export function isAnyStreamActive(): boolean {
  return active.size > 0
}

/** Subscribe to activity changes. Returns an unsubscribe function. */
export function subscribeStreamActivity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
