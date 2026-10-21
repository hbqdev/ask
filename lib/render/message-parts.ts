// Pure answer/research rules for an assistant message's parts, shared by the
// web (components/render-message.tsx) and the mobile app. Keep this module free
// of React, next/* and server code: only type imports from 'ai'.
import type { UIMessage } from 'ai'

type MessagePart = UIMessage['parts'][number]

/**
 * Only the latest message can be streaming. Keying this off the global chat
 * status alone would make every earlier, finished message re-enter streaming
 * rendering whenever a new turn runs.
 */
export function isTurnStreaming(
  isLatestMessage: boolean,
  status: string
): boolean {
  return isLatestMessage && (status === 'streaming' || status === 'submitted')
}

/**
 * Whether a text part is the user-facing answer rather than interim narration.
 * Once the turn is complete, the last non-empty text part is the answer. While
 * streaming, nothing has followed the current part yet, so lean on the
 * first-token rule every mode's prompt enforces: the final answer, and nothing
 * else, starts with a markdown heading.
 */
export function isAnswerText(
  text: string,
  opts: { streamingComplete: boolean; isLastNonEmptyTextPart: boolean }
): boolean {
  if (text.trim().length === 0) return false
  return opts.streamingComplete
    ? opts.isLastNonEmptyTextPart
    : /^#{1,6}\s/.test(text.trimStart())
}

/**
 * A generated image is answer content (a standalone image card). It streams
 * live as `tool-generateImage`, and a reloaded turn can rehydrate it as a
 * `dynamic-tool` named `generateImage`.
 */
export function isGeneratedImagePart(part: MessagePart): boolean {
  return (
    part.type === 'tool-generateImage' ||
    (part.type === 'dynamic-tool' && part.toolName === 'generateImage')
  )
}

/**
 * Whether a part is a research step that buffers into the collapsed research
 * process: reasoning, the classifier, attachments, a recall with at least one
 * chat, and every tool part (static or dynamic) except the generated image.
 */
export function isResearchPart(part: MessagePart): boolean {
  if (isGeneratedImagePart(part)) return false
  switch (part.type) {
    case 'reasoning':
    case 'data-classifier':
    case 'data-attachments':
    case 'dynamic-tool':
      return true
    case 'data-recall': {
      const data = (part as { data?: { chats?: unknown[] } }).data
      return Boolean(data?.chats?.length)
    }
    default:
      // Tolerate a malformed part with no type, as the web always has.
      return typeof part.type === 'string' && part.type.startsWith('tool-')
  }
}
