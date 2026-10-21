// How an assistant message lays out in the thread: research steps collapse
// into blocks, a generated image stands alone, and only answer text shows.
// The same rules as the web's components/render-message.tsx, built on the
// shared predicates in Ask's lib/render/message-parts. Pure: no React.
import type { UIMessage } from 'ai'

import {
  isAnswerText,
  isGeneratedImagePart,
  isResearchPart
} from '@/lib/render/message-parts'
import { narrationCleanView } from '@/lib/streaming/helpers/strip-narration-from-message'

type Part = UIMessage['parts'][number]

export type Block =
  | { kind: 'research'; parts: Part[]; live: boolean }
  | { kind: 'answer'; text: string }
  | { kind: 'image'; part: Part }

function nonEmptyText(part: Part): string | null {
  return part.type === 'text' && part.text.trim().length > 0 ? part.text : null
}

/**
 * The blocks of an assistant message, in order. `streaming` is whether this
 * message's turn is still streaming (see isTurnStreaming). A research block
 * is live only while streaming and when nothing has followed it yet.
 */
export function layoutAssistantMessage(
  message: UIMessage,
  streaming: boolean
): Block[] {
  const parts = narrationCleanView(message).parts
  const blocks: Block[] = []
  let buffer: Part[] = []

  const flush = () => {
    if (buffer.length === 0) return
    blocks.push({ kind: 'research', parts: buffer, live: false })
    buffer = []
  }

  let lastTextIndex = -1
  parts.forEach((part, i) => {
    if (nonEmptyText(part) !== null) lastTextIndex = i
  })

  parts.forEach((part, i) => {
    const text = nonEmptyText(part)
    if (text !== null) {
      const answer = isAnswerText(text, {
        streamingComplete: !streaming,
        isLastNonEmptyTextPart: i === lastTextIndex
      })
      if (!answer) return
      flush()
      blocks.push({ kind: 'answer', text })
    } else if (isGeneratedImagePart(part)) {
      flush()
      blocks.push({ kind: 'image', part })
    } else if (isResearchPart(part)) {
      buffer.push(part)
    }
  })
  flush()

  const last = blocks[blocks.length - 1]
  if (streaming && last?.kind === 'research') last.live = true
  return blocks
}
