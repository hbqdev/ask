// In-memory registry of running generations so an explicit Stop can abort a
// turn. Decoupling the authed generation from req.signal (app/api/chat/route.ts)
// means a client DISCONNECT no longer stops it — which is the whole point (a
// backgrounded mobile tab should keep generating). But a deliberate Stop still
// must halt server compute. Ask runs ONE Node process per container (not
// serverless / multi-instance), so the Stop request and the generation share
// the process and an in-memory map is sufficient and reliable.

const controllers = new Map<string, AbortController>()

/**
 * Register the running turn for a chat and return its AbortController. A new
 * turn supersedes (and aborts) any stale controller for the same chat.
 */
export function registerGeneration(chatId: string): AbortController {
  controllers.get(chatId)?.abort()
  const controller = new AbortController()
  controllers.set(chatId, controller)
  return controller
}

/** Abort the running turn for a chat (the Stop button). Returns whether one was found. */
export function stopGeneration(chatId: string): boolean {
  const controller = controllers.get(chatId)
  if (!controller) return false
  controller.abort()
  controllers.delete(chatId)
  return true
}

/** Drop the registry entry once a turn finishes, but only if it's still the current one. */
export function unregisterGeneration(
  chatId: string,
  controller: AbortController
): void {
  if (controllers.get(chatId) === controller) controllers.delete(chatId)
}
