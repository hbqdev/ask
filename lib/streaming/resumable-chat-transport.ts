import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk
} from 'ai'

export interface ResumeHooks {
  /**
   * A live stream was found. Called with the replayed turn's message id
   * BEFORE the SDK starts applying the replay, so the caller can drop the
   * partial copy of that message it is still showing (the replay starts from
   * the turn's first chunk and would otherwise be appended on top of it,
   * duplicating every text/reasoning part).
   */
  onReplayStart?: (messageId: string | undefined) => void
  /** The endpoint answered 204: no live stream (never started, or already finished). */
  onNothingToResume?: () => void
}

/**
 * DefaultChatTransport whose reconnect (resume) path reports its outcome.
 * `useChat` builds a resumed turn ON TOP of the last assistant message, and
 * the resumable stream replays the whole turn from the start — so without
 * dropping the partial first, a resume after a real disconnect shows every
 * part twice. And a 204 is a silent no-op in the SDK, which left a stale
 * partial on screen when the turn finished while the client was away.
 */
export class ResumableChatTransport<
  M extends UIMessage
> extends DefaultChatTransport<M> {
  constructor(
    options: HttpChatTransportInitOptions<M>,
    private readonly hooks: ResumeHooks
  ) {
    super(options)
  }

  async reconnectToStream(
    options: Parameters<DefaultChatTransport<M>['reconnectToStream']>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const stream = await super.reconnectToStream(options)
    if (!stream) {
      this.hooks.onNothingToResume?.()
      return null
    }
    return peekStartChunk(stream, id => this.hooks.onReplayStart?.(id))
  }
}

/**
 * Read the stream's first chunk (the turn's `start`, which carries the message
 * id), report it, then hand back an equivalent stream that still yields that
 * chunk first.
 */
export async function peekStartChunk(
  stream: ReadableStream<UIMessageChunk>,
  onStart: (messageId: string | undefined) => void
): Promise<ReadableStream<UIMessageChunk>> {
  const reader = stream.getReader()
  const first = await reader.read()
  onStart(
    !first.done && first.value.type === 'start'
      ? first.value.messageId
      : undefined
  )
  let pendingFirst = first.done ? null : first.value
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (pendingFirst) {
        controller.enqueue(pendingFirst)
        pendingFirst = null
        return
      }
      const next = await reader.read()
      if (next.done) controller.close()
      else controller.enqueue(next.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
}
