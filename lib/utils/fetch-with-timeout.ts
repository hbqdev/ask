// Wraps the global fetch with a hard per-request timeout, for use as the
// `fetch` option AI SDK providers accept (openai/anthropic/google/
// openai-compatible/gateway/ollama all support overriding it this way).
//
// This exists because passing an `abortSignal` into a ToolLoopAgent's
// `.stream()` call does not reliably cancel an already-in-flight HTTP
// request to the model provider — verified live: a request stuck mid-call
// kept running for 4+ minutes with zero effect after that outer signal
// fired. Wrapping the actual fetch each provider uses is the one place a
// timeout is guaranteed to actually cut the request off, regardless of
// whether the SDK's own abort plumbing works for a given provider/version.
//
// `externalSignal` is for providers where that gap goes further: ai-sdk-ollama
// drops the AI SDK's per-call abortSignal entirely (getCallOptions() never
// reads it, so it's never forwarded to the ollama client's own fetch call —
// confirmed by reading its source). For those, the caller passes the actual
// request's abortSignal here so a client disconnect still cuts the request
// short instead of always running to the fixed timeoutMs ceiling.
export function createTimeoutFetch(
  timeoutMs: number,
  externalSignal?: AbortSignal
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException(
          'The operation was aborted due to timeout',
          'TimeoutError'
        )
      )
    }, timeoutMs)

    // Honor whatever signal(s) are already relevant, first to fire wins:
    // - the caller's own signal (e.g. the AI SDK's per-call abortSignal, for
    //   providers that do forward it into fetch's init.signal)
    // - the externalSignal passed in above, for providers that don't
    const signals = [init?.signal, externalSignal].filter(
      (s): s is AbortSignal => s != null
    )
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
      } else {
        signal.addEventListener(
          'abort',
          () => controller.abort(signal.reason),
          {
            once: true
          }
        )
      }
    }

    const response = await fetch(input, { ...init, signal: controller.signal })

    // fetch()'s own promise resolves once response headers arrive — for a
    // streaming chat completion, that's only the very start. A naive
    // `.finally(() => clearTimeout(timer))` chained on the fetch() promise
    // clears the deadline the instant headers land, leaving the entire body
    // stream (where a model actually generates tokens, and where the real
    // production hang occurred) with no timeout at all. Verified live: a
    // request whose body streamed for 7+ minutes was never cut off, because
    // the timer had already been cleared within the first second. Keep the
    // timer alive until the body itself finishes — the abort still covers
    // the whole request via `controller.signal` regardless of when it fires.
    if (!response.body) {
      clearTimeout(timer)
      return response
    }

    const timedBody = response.body.pipeThrough(
      new TransformStream({
        flush() {
          clearTimeout(timer)
        }
      })
    )

    return new Response(timedBody, response)
  }
}
