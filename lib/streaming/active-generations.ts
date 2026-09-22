// In-memory registry of running generations so an explicit Stop can abort a
// turn. Decoupling the authed generation from req.signal (app/api/chat/route.ts)
// means a client DISCONNECT no longer stops it — which is the whole point (a
// backgrounded mobile tab should keep generating). But a deliberate Stop still
// must halt server compute. Ask runs ONE Node process per container (not
// serverless / multi-instance), so the Stop request and the generation share
// the process and an in-memory map is sufficient and reliable.

// Abort reasons, so onFinish can tell WHY a turn was cut short. Only an
// explicit user Stop persists the partial answer; a turn superseded by a newer
// one (or killed by the generation timeout) keeps the old discard behavior.
// The reasons are AbortError DOMExceptions (not bare strings): the AI SDK only
// recognizes an abort by the thrown error's name, and a bare-string reason
// surfaces as a stream ERROR instead of an abort.
export const USER_STOP_REASON = 'ask:user-stop'
export const SUPERSEDED_REASON = 'ask:superseded'
const abortReason = (message: string) => new DOMException(message, 'AbortError')

// How long a follow-up turn waits for a just-stopped turn to finish saving its
// partial answer before it reads the conversation history. Bounded so a stuck
// save can never wedge the chat.
export const STOPPED_TURN_SETTLE_TIMEOUT_MS = 5_000

const controllers = new Map<string, AbortController>()

interface Settle {
  promise: Promise<void>
  resolve: () => void
}
// Chats whose turn was stopped by the user and whose onFinish (partial-answer
// save) has not completed yet. Created at stop time — not in onFinish — because
// a quick follow-up request can arrive before the aborted stream even reaches
// onFinish.
const pendingStoppedSaves = new Map<string, Settle>()

/**
 * Register the running turn for a chat and return its AbortController. A new
 * turn supersedes (and aborts) any stale controller for the same chat.
 */
export function registerGeneration(chatId: string): AbortController {
  controllers.get(chatId)?.abort(abortReason(SUPERSEDED_REASON))
  const controller = new AbortController()
  controllers.set(chatId, controller)
  return controller
}

/** Abort the running turn for a chat (the Stop button). Returns whether one was found. */
export function stopGeneration(chatId: string): boolean {
  const controller = controllers.get(chatId)
  if (!controller) return false
  if (!pendingStoppedSaves.has(chatId)) {
    let resolve!: () => void
    const promise = new Promise<void>(r => (resolve = r))
    pendingStoppedSaves.set(chatId, { promise, resolve })
    // Never leak an entry if the turn somehow never reaches onFinish.
    setTimeout(
      () => settleStoppedTurn(chatId),
      STOPPED_TURN_SETTLE_TIMEOUT_MS * 2
    ).unref?.()
  }
  controller.abort(abortReason(USER_STOP_REASON))
  controllers.delete(chatId)
  return true
}

/** True when this turn's kill controller was fired by an explicit user Stop. */
export function wasStoppedByUser(
  controller: AbortController | null | undefined
): boolean {
  const reason: unknown = controller?.signal.aborted
    ? controller.signal.reason
    : undefined
  return reason instanceof DOMException && reason.message === USER_STOP_REASON
}

/** Mark a stopped turn's partial-answer save as done (or skipped). */
export function settleStoppedTurn(chatId: string): void {
  const settle = pendingStoppedSaves.get(chatId)
  if (!settle) return
  pendingStoppedSaves.delete(chatId)
  settle.resolve()
}

/**
 * Wait (bounded) for a just-stopped turn of this chat to finish saving its
 * partial answer, so the next turn's history includes it instead of showing
 * the model two consecutive user messages. Resolves immediately when nothing
 * is pending.
 */
export async function waitForStoppedTurn(
  chatId: string,
  timeoutMs = STOPPED_TURN_SETTLE_TIMEOUT_MS
): Promise<void> {
  const settle = pendingStoppedSaves.get(chatId)
  if (!settle) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    settle.promise,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
    })
  ])
  if (timer) clearTimeout(timer)
}

/** Drop the registry entry once a turn finishes, but only if it's still the current one. */
export function unregisterGeneration(
  chatId: string,
  controller: AbortController
): void {
  if (controllers.get(chatId) === controller) controllers.delete(chatId)
}
