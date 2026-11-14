import { captureClient } from '@/lib/analytics/posthog-client'
import type { UIMessage, UIMessageMetadata } from '@/lib/types/ai'

import { buildFollowupRequest } from './build-request'
import { fetchFollowups } from './fetch-followups'

type LoadFollowupsArgs = {
  message: UIMessage
  messages: UIMessage[]
  chatId: string | null
  isCurrentChat: boolean
  isAbort: boolean
  isError: boolean
  /** Guests can't call the endpoint (it needs a user), so they get none. */
  isGuest: boolean
  setMessages: (update: (current: UIMessage[]) => UIMessage[]) => void
}

/**
 * Called from useChat's onFinish: ask for follow-up questions for a
 * completed answer in the chat on screen and store them on the message's
 * metadata, where AnswerSection renders them. A stopped or failed turn, a
 * turn from a chat this view has left, and a clarifying question get none.
 */
export async function loadFollowupsAfterFinish({
  message,
  messages,
  chatId,
  isCurrentChat,
  isAbort,
  isError,
  isGuest,
  setMessages
}: LoadFollowupsArgs): Promise<void> {
  if (!isCurrentChat || isAbort || isError || isGuest) return
  const req = buildFollowupRequest(message, messages, chatId)
  if (!req) return

  const questions = await fetchFollowups(req)
  if (questions.length === 0) return

  setMessages(current =>
    current.map(m =>
      m.id === message.id
        ? {
            ...m,
            metadata: {
              ...(m.metadata as UIMessageMetadata | undefined),
              followups: questions
            }
          }
        : m
    )
  )
  captureClient('followups_shown', { chatId, count: questions.length })
}
