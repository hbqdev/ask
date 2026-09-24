import type { UIMessage } from 'ai'

// A user-stopped turn's assistant message is a snapshot taken mid-stream: it can
// hold tool calls that never got a result, text/reasoning parts still marked
// `streaming`, empty text shells, and `running` progress steps. Persisting that
// as-is would (a) render forever-spinning steps on reload and (b) hand the NEXT
// turn's model a tool call with no matching result — which providers reject.
// This keeps only what is complete and meaningful.

// Tool states the persistence layer can round-trip AND that convert to a valid
// call+result pair for the model (see lib/utils/message-mapping.ts).
const SETTLED_TOOL_STATES = new Set(['output-available', 'output-error'])

function isToolPart(type: string): boolean {
  return type.startsWith('tool-') || type === 'dynamic-tool'
}

function hasText(part: { text?: unknown }): boolean {
  return typeof part.text === 'string' && part.text.trim().length > 0
}

/**
 * Strip a stopped assistant message down to its settled parts and flag it as
 * stopped. Returns null when nothing meaningful remains (no answer text and no
 * completed tool result) — the caller then keeps the old discard behavior.
 */
export function sanitizeStoppedMessage<T extends UIMessage>(msg: T): T | null {
  if (msg.role !== 'assistant' || !Array.isArray(msg.parts)) return null

  const kept: T['parts'] = []
  for (const part of msg.parts) {
    const p = part as {
      type: string
      state?: string
      text?: string
      data?: { state?: string }
    }
    if (p.type === 'text' || p.type === 'reasoning') {
      if (!hasText(p)) continue
      kept.push(
        p.state === 'streaming'
          ? ({ ...part, state: 'done' } as typeof part)
          : part
      )
      continue
    }
    if (isToolPart(p.type)) {
      if (p.state && SETTLED_TOOL_STATES.has(p.state)) kept.push(part)
      continue
    }
    if (p.type.startsWith('data-')) {
      // Progress steps still `running` would spin forever on reload.
      if (p.data?.state === 'running') continue
      kept.push(part)
      continue
    }
    kept.push(part)
  }

  // Collapse step-start markers that no longer open any content (their tool
  // call was dropped) — leading, repeated, or trailing.
  const parts: T['parts'] = []
  for (let i = 0; i < kept.length; i++) {
    const part = kept[i]
    if (part.type === 'step-start') {
      const next = kept[i + 1]
      if (!next || next.type === 'step-start') continue
    }
    parts.push(part)
  }

  const meaningful = parts.some(
    part =>
      (part.type === 'text' && hasText(part as { text?: unknown })) ||
      (isToolPart(part.type) &&
        SETTLED_TOOL_STATES.has((part as { state?: string }).state ?? ''))
  )
  if (!meaningful) return null

  return {
    ...msg,
    parts,
    metadata: {
      ...((msg.metadata as Record<string, unknown> | undefined) ?? {}),
      stopped: true
    }
  }
}

/**
 * Whether a stopped turn's late save would land out of order: a newer turn has
 * already written to this chat since the stopped turn's user message. Safe to
 * save only when the newest persisted message is still this turn's user
 * message (or this very assistant message, e.g. a retried save).
 */
export function isStoppedSaveStale(
  latestMessageId: string | null | undefined,
  turnUserMessageId: string | null | undefined,
  responseMessageId: string
): boolean {
  if (!latestMessageId || !turnUserMessageId) return true
  return (
    latestMessageId !== turnUserMessageId &&
    latestMessageId !== responseMessageId
  )
}

/**
 * Client-side twin of the `stopped: true` flag sanitizeStoppedMessage persists:
 * flag the assistant message `messageId` as stopped in a useChat message list so
 * the "Stopped" badge shows immediately, without waiting for a reload. Returns
 * the same array when there is nothing to flag (unknown id, not an assistant
 * message, already flagged) so a React state setter can bail out.
 */
export function markMessageStopped<T extends UIMessage>(
  messages: T[],
  messageId: string | undefined
): T[] {
  if (!messageId) return messages
  const index = messages.findIndex(m => m.id === messageId)
  if (index === -1) return messages
  const msg = messages[index]
  const metadata = (msg.metadata as Record<string, unknown> | undefined) ?? {}
  if (msg.role !== 'assistant' || metadata.stopped === true) return messages
  const next = messages.slice()
  next[index] = { ...msg, metadata: { ...metadata, stopped: true } }
  return next
}
