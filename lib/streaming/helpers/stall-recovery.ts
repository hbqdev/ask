// Recover a turn whose model stream goes silent mid-generation.
//
// THE FAILURE THIS EXISTS FOR. Lab chat ovd3r52d9mf9hrq49mzjz5pb, one turn:
// retrieval finished healthily in 24.3s, the model emitted `reasoning-start`
// and a single `reasoning-delta` at 26.4s, and then produced NOTHING for 302
// seconds until route.ts's GENERATION_TIMEOUT_MS (300s) aborted the request.
// onFinish returns early on `isAborted`, so nothing was persisted. The user
// waited five and a half minutes for a blank page.
//
// Nothing in the stack bounded that silence. GENERATION_TIMEOUT_MS bounds the
// whole turn, which is the right backstop and the wrong instrument: by the
// time it fires the turn is already lost, and it cannot tell a model that is
// working slowly from one that has stopped.
//
// WHY THE PIPELINE CAN RETRY AND THE LOOP CANNOT. Two reasons, both structural:
//
//   * Under the loop, silence is often CORRECT. Between `tool-input-available`
//     and `tool-output-available` no parts flow while the tool runs, and a deep
//     crawl on this stack has been measured at crawl_ms 125004 — over two
//     minutes of legitimate quiet. Any inactivity threshold low enough to catch
//     a stall would kill healthy research turns.
//   * Under the pipeline, retrieval has already completed before the model is
//     called. There are no tools in flight, the prompt is fully determined, and
//     every source is in hand. Silence can only mean the provider stalled, and
//     re-issuing the call reproduces the identical request.
//
// So this is deliberately scoped to the pipeline architecture rather than
// written as a general stream watchdog. See the call site in
// create-chat-stream-response.ts.
//
// THE RETRY IS FREE ON A DOOMED TURN. A stall with no prose emitted ends as a
// blank page whatever we do; a second attempt cannot make that outcome worse,
// and it costs only the time we bound here. That argument does NOT hold once
// prose has been committed — the client has already rendered it, and restarting
// would either duplicate or contradict what the user is reading. Hence
// `isCommitted`: after the first text part this degrades to a plain watchdog
// that stops waiting and keeps the partial answer.

export type StallRecoveryEvent =
  | { type: 'stall'; attempt: number; committed: boolean; silentMs: number }
  | { type: 'retry'; attempt: number }
  | { type: 'exhausted'; attempts: number }

/**
 * Default silence, in ms, after which a pipeline generation is treated as dead.
 *
 * Chosen against the observed distribution, not as a round number. On this
 * stack the gap between retrieval completing and the first stream part is
 * consistently ~2.1s (measured across the turns in that chat: 70323->72465,
 * 24301->26428), and once reasoning starts the deltas stream continuously. The
 * only silence longer than a few seconds ever recorded is the 302s stall this
 * guard exists to catch. 60s therefore sits an order of magnitude above normal
 * behaviour and still leaves room, under the 300s ceiling, for the retry to
 * run to completion.
 */
export const DEFAULT_STALL_MS = 60_000

/**
 * Wrap a stream-producing attempt so a mid-generation stall is retried once.
 *
 * `attempt` is called with a signal that this function aborts when it gives up
 * waiting; callers must pass it through to the model call, and should combine
 * it with the request's own signal so a real client disconnect still wins.
 *
 * Never rejects for a stall that it recovers from. A stall it cannot recover
 * from (already committed, or attempts exhausted) surfaces as it would have
 * without this wrapper.
 */
export function withStallRecovery<T>(opts: {
  attempt: (signal: AbortSignal) => Promise<ReadableStream<T>>
  /** True once a chunk represents user-visible output we must not duplicate. */
  isCommitted: (chunk: T) => boolean
  stallMs?: number
  /** Total attempts including the first. 2 means "retry once". */
  maxAttempts?: number
  onEvent?: (event: StallRecoveryEvent) => void
}): ReadableStream<T> {
  const {
    attempt,
    isCommitted,
    stallMs = DEFAULT_STALL_MS,
    maxAttempts = 2,
    onEvent
  } = opts

  // Held so cancel() can abandon whatever attempt is in flight; without it a
  // client disconnect leaves the model call running to completion.
  let live: AbortController | undefined
  let cancelled = false

  const pump = async (controller: ReadableStreamDefaultController<T>) => {
    // Commitment persists ACROSS attempts on purpose: once prose has reached
    // the client, no later attempt may restart, however it fails.
    let committed = false
    let lastError: unknown

    for (let n = 1; n <= maxAttempts; n++) {
      if (cancelled) return

      const ac = new AbortController()
      live = ac
      let stalled = false
      let lastPartAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined

      const disarm = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
      }
      const arm = () => {
        disarm()
        timer = setTimeout(() => {
          stalled = true
          onEvent?.({
            type: 'stall',
            attempt: n,
            committed,
            silentMs: Date.now() - lastPartAt
          })
          // Aborting is what unblocks the read below: the provider stream
          // rejects or closes, and control returns to the catch.
          ac.abort()
        }, stallMs)
      }

      let reader: ReadableStreamDefaultReader<T> | undefined
      try {
        const source = await attempt(ac.signal)
        reader = source.getReader()
        arm()

        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            disarm()
            controller.close()
            return
          }
          lastPartAt = Date.now()
          arm()
          if (!committed && isCommitted(value)) committed = true
          controller.enqueue(value)
        }
      } catch (error) {
        lastError = error
        const recoverable =
          stalled && !committed && !cancelled && n < maxAttempts
        if (recoverable) {
          onEvent?.({ type: 'retry', attempt: n + 1 })
          continue
        }
        if (cancelled) return
        if (committed) {
          // Partial prose beats an error the client renders as a failed turn:
          // closing here lets onFinish persist what was actually written.
          controller.close()
          return
        }
        if (stalled) onEvent?.({ type: 'exhausted', attempts: n })
        controller.error(error)
        return
      } finally {
        disarm()
        // Release the provider stream. Best-effort: it is already aborted on
        // the stall path, and a cancel that throws must not mask lastError.
        try {
          await reader?.cancel()
        } catch {
          /* nothing useful to do with a cancel failure */
        }
      }
    }

    controller.error(lastError ?? new Error('stall recovery exhausted'))
  }

  return new ReadableStream<T>({
    start(controller) {
      // Not awaited: returning the promise would hold the stream in its
      // starting state and defer pull(), and everything here is driven by
      // enqueue anyway.
      void pump(controller)
    },
    cancel() {
      cancelled = true
      live?.abort()
    }
  })
}

/**
 * Has this UI-message part put visible prose in front of the user?
 *
 * Text parts only. Reasoning is deliberately NOT commitment: it renders in a
 * collapsible panel, and a retry that produces a second reasoning block there
 * is cosmetic. Treating it as commitment would forfeit recovery on exactly the
 * stall we saw, which died between `reasoning-delta` and `reasoning-end`.
 */
export function isVisibleTextPart(chunk: unknown): boolean {
  const type = (chunk as { type?: unknown } | null)?.type
  return typeof type === 'string' && type.startsWith('text-')
}
