import { UIMessage } from 'ai'

import { stripNarrationPreamble } from './strip-narration-preamble'

/**
 * Cleans a single assistant message by stripping any narration preamble
 * from its text parts. Non-text parts and non-assistant messages are
 * returned unchanged. Mirrors the pattern in strip-reasoning-parts.ts /
 * strip-spec-from-messages.ts.
 */
export function stripNarrationFromMessage<T extends UIMessage>(msg: T): T {
  if (msg.role !== 'assistant' || !msg.parts) {
    return msg
  }

  let mutated = false
  const parts = msg.parts.map(part => {
    if (part.type !== 'text' || typeof (part as any).text !== 'string') {
      return part
    }
    const text = (part as any).text as string
    const cleaned = stripNarrationPreamble(text)
    if (cleaned === text) return part
    mutated = true
    return { ...part, text: cleaned }
  })

  return mutated ? ({ ...msg, parts } as T) : msg
}

export function stripNarrationFromMessages<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.map(m => stripNarrationFromMessage(m))
}
