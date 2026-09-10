import { UIMessage } from 'ai'

import {
  looksLikeNarrationStart,
  stripNarrationPreamble
} from './strip-narration-preamble'

/** A tool-invocation part (`tool-<name>` or the generic `dynamic-tool`). */
function isToolPart(part: unknown): boolean {
  const type = (part as { type?: unknown })?.type
  return (
    typeof type === 'string' &&
    (type.startsWith('tool-') || type === 'dynamic-tool')
  )
}

/** A text part carrying visible content (whitespace-only is treated empty). */
function isNonEmptyTextPart(part: unknown): boolean {
  const p = part as { type?: unknown; text?: unknown }
  return (
    p?.type === 'text' &&
    typeof p.text === 'string' &&
    (p.text as string).trim().length > 0
  )
}

/**
 * Cleans a single assistant message by stripping "thinking out loud"
 * narration from its text parts. Two kinds of leak are handled:
 *
 * 1. **Fused preamble** — narration written directly in front of the final
 *    answer's `## ` heading, in the SAME text part. Stripped per-part by
 *    `stripNarrationPreamble` (needs the heading to anchor the cut).
 *
 * 2. **Inter-step narration** — in an agentic multi-step turn the model emits
 *    a standalone narration TEXT part ("I have comprehensive data now. Let me
 *    search…"), THEN makes another tool call, THEN writes the real answer in a
 *    later text part. That earlier text part has no heading, so (1) can't touch
 *    it — but it is unmistakably process chatter, not the answer: only the
 *    FINAL text part (after the last tool call) is the answer. The client
 *    render path already mutes non-final text visually, but the raw part still
 *    reaches every non-render consumer — the transcript fed back as history to
 *    the next turn, search indexing, sharing/export — so it must be removed
 *    from the persisted message here. A non-final text part that is
 *    narration-shaped (and followed by a later tool call or text part) is
 *    dropped entirely.
 *
 * Non-text parts and non-assistant messages are returned unchanged. Mirrors the
 * pattern in strip-reasoning-parts.ts / strip-spec-from-messages.ts.
 */
export function stripNarrationFromMessage<T extends UIMessage>(msg: T): T {
  if (msg.role !== 'assistant' || !msg.parts) {
    return msg
  }

  const parts = msg.parts

  // The real answer is the LAST non-empty text part. Anything text-shaped
  // before it is a candidate for inter-step narration.
  let lastTextIdx = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isNonEmptyTextPart(parts[i])) {
      lastTextIdx = i
      break
    }
  }

  let mutated = false
  const out: typeof parts = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type !== 'text' || typeof (part as any).text !== 'string') {
      out.push(part)
      continue
    }
    const text = (part as any).text as string

    // Inter-step narration: a text part that is NOT the final answer, IS
    // narration-shaped, and is followed by a later tool call or text part
    // (proof it is mid-turn chatter, not the answer). Drop it wholesale.
    const isFinalAnswerText = i === lastTextIdx
    const followedByToolOrText = parts
      .slice(i + 1)
      .some(p => isToolPart(p) || isNonEmptyTextPart(p))
    if (
      !isFinalAnswerText &&
      followedByToolOrText &&
      text.trim().length > 0 &&
      looksLikeNarrationStart(text)
    ) {
      mutated = true
      continue
    }

    // Otherwise strip any fused preamble in place (heading-anchored).
    const cleaned = stripNarrationPreamble(text)
    if (cleaned === text) {
      out.push(part)
      continue
    }
    mutated = true
    out.push({ ...part, text: cleaned })
  }

  return mutated ? ({ ...msg, parts: out } as T) : msg
}

export function stripNarrationFromMessages<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.map(m => stripNarrationFromMessage(m))
}
