import { UIMessage } from 'ai'

/**
 * Strips any `data-recall` part from a message before persistence.
 *
 * The recall attribution chips are a claim about *this* generation only
 * ("past conversations relevant to this turn") and must never reach the DB:
 * the generic data-* persistence path (lib/utils/message-mapping.ts) stores
 * ANY `data-*` part verbatim, including the `{chats:[{chatId,title}]}`
 * payload, and the public-chat RLS policy exposes every part of a shared
 * chat to anonymous visitors. Without this strip, recall pulling an excerpt
 * from private chat A into chat B, followed by sharing B, leaks chat A's
 * title/id to anyone who opens the public link. Making the chips
 * live-turn-only is also more honest — the chip is only ever a statement
 * about the turn that just streamed, not a durable fact about the message.
 *
 * Mirrors strip-narration-from-message.ts's shape/immutability: returns the
 * original object unchanged (no defensive copy) when there is nothing to
 * strip, and otherwise returns a new message with a new parts array rather
 * than mutating the input.
 */
export function stripRecallFromMessage<T extends UIMessage>(msg: T): T {
  if (!msg.parts) {
    return msg
  }

  const hasRecall = msg.parts.some(part => part.type === 'data-recall')
  if (!hasRecall) {
    return msg
  }

  return {
    ...msg,
    parts: msg.parts.filter(part => part.type !== 'data-recall')
  } as T
}
