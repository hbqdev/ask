import { UIMessage } from 'ai'

import {
  looksLikeInterStepChatter,
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
 * True when the next significant part after `index` — skipping step-start,
 * reasoning, data-* and empty text parts — is a tool call. That is the shape
 * of a step that ended by calling a tool: its text was written BEFORE the
 * tool ran, so it cannot be an answer grounded in that tool's result.
 */
function isFollowedByToolCall(parts: readonly unknown[], index: number) {
  for (let j = index + 1; j < parts.length; j++) {
    if (isToolPart(parts[j])) return true
    if (isNonEmptyTextPart(parts[j])) return false
  }
  return false
}

/**
 * Cleans a single assistant message by stripping "thinking out loud"
 * narration from its text parts. Two kinds of leak are handled:
 *
 * 1. **Fused preamble** — narration written directly in front of the final
 *    answer's `## ` heading, in the SAME text part. Stripped per-part by
 *    `stripNarrationPreamble`: the English phrase rules (heading-anchored),
 *    then the language-agnostic GLUED-SEAM cut (`…rồi.## Title`), which needs
 *    no phrase list.
 *
 * 2. **Inter-step narration** — in an agentic multi-step turn the model emits
 *    a standalone narration TEXT part ("I have comprehensive data now. Let me
 *    search…", "Tôi cần đọc trang này…"), THEN makes another tool call, THEN
 *    writes the real answer in a later text part. Only the FINAL text part is
 *    the answer. The client render path already hides non-final text once the
 *    turn is done, but the raw part still reaches every non-render consumer —
 *    the transcript fed back as history to the next turn, search indexing,
 *    copy/export — so it is removed here. A non-final text part is dropped
 *    when it is followed by a later tool call or text part AND either
 *    (a) starts with a known English narration phrase (any length), or
 *    (b) is directly followed by a tool call, is short, unstructured prose
 *        (`looksLikeInterStepChatter`) — in ANY language — and is no longer
 *        than the final answer.
 *
 * Non-text parts and non-assistant messages are returned unchanged, and an
 * unchanged message is returned by identity. Pure and idempotent, so the
 * same function serves the persist path, history fed back to the model, and
 * the client render path (which applies it to stored and streaming messages
 * alike). Mirrors strip-reasoning-parts.ts / strip-spec-from-messages.ts.
 */
export function stripNarrationFromMessage<T extends UIMessage>(msg: T): T {
  if (msg?.role !== 'assistant' || !Array.isArray(msg.parts)) {
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

  // Length of the final answer. The structural (any-language) rule only drops
  // chatter no longer than the answer that follows it, so the shape "a real
  // short reply, then a side-effect tool (remember, generateImage), then a
  // one-line sign-off" keeps its reply.
  const finalAnswerLength =
    lastTextIdx >= 0
      ? ((parts[lastTextIdx] as any).text as string).trim().length
      : 0

  let mutated = false
  const out: typeof parts = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type !== 'text' || typeof (part as any).text !== 'string') {
      out.push(part)
      continue
    }
    const text = (part as any).text as string

    // Inter-step narration: a non-empty text part BEFORE the final answer
    // (the last non-empty text part follows it, so it is mid-turn by
    // construction). Drop it wholesale when it is narration-shaped.
    if (i < lastTextIdx && text.trim().length > 0) {
      const narration =
        looksLikeNarrationStart(text) ||
        (isFollowedByToolCall(parts, i) &&
          text.trim().length <= finalAnswerLength &&
          looksLikeInterStepChatter(text))
      if (narration) {
        mutated = true
        continue
      }
    }

    // Otherwise strip any fused preamble in place.
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

// Memo for the render path, keyed by message object. Safe because messages
// are immutable snapshots there: @ai-sdk/react structuredClone()s a message
// into state on every streamed update, so a changed message is a NEW object
// and an unchanged one keeps its identity (and its cached view). Chats render
// every message on each streamed delta; this keeps that O(changed messages).
const displayViewCache = new WeakMap<object, UIMessage>()

/**
 * The narration-free view of a message for DISPLAY and client-side copy —
 * `stripNarrationFromMessage`, memoized per message object. Applied to stored
 * messages (so answers saved before a rule existed render clean without a DB
 * rewrite) and to the live streaming message (which cleans itself as soon as
 * the glued `## ` seam or the next tool call arrives).
 */
export function narrationCleanView<T extends UIMessage>(msg: T): T {
  if (msg?.role !== 'assistant' || !Array.isArray(msg.parts)) return msg
  const cached = displayViewCache.get(msg)
  if (cached) return cached as T
  const view = stripNarrationFromMessage(msg)
  displayViewCache.set(msg, view)
  return view
}
