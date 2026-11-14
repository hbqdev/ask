import { stripSpecBlocks } from '@/lib/render/strip-spec-blocks'
import type { UIMessage } from '@/lib/types/ai'
import { getTextFromParts } from '@/lib/utils/message-utils'

import type { FollowupRequest } from './types'

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool'
}

/**
 * The follow-up request for a finished assistant message, or null when it
 * should get none: not an assistant message, a clarifying question (the
 * user answers that instead), or no answer text.
 *
 * `answer` is the text after the last tool part (pre-tool narration is not
 * the answer) with spec blocks stripped; `question` is the user turn this
 * message answers and `previousQuestions` the user turns before it.
 */
export function buildFollowupRequest(
  message: UIMessage,
  messages: UIMessage[],
  chatId: string | null
): FollowupRequest | null {
  if (message.role !== 'assistant') return null
  const parts = message.parts ?? []
  if (parts.some(part => part.type === 'tool-askQuestion')) return null

  let lastTool = -1
  parts.forEach((part, i) => {
    if (isToolPart(part)) lastTool = i
  })
  const answer = stripSpecBlocks(getTextFromParts(parts.slice(lastTool + 1)))
  if (!answer) return null

  const index = messages.findIndex(m => m.id === message.id)
  const before = index === -1 ? messages : messages.slice(0, index)
  const userTexts = before
    .filter(m => m.role === 'user')
    .map(m => getTextFromParts(m.parts).trim())
    .filter(Boolean)
  const question = userTexts.pop()
  if (!question) return null

  return {
    question,
    answer,
    previousQuestions: userTexts,
    ...(chatId ? { chatId, messageId: message.id } : {})
  }
}
