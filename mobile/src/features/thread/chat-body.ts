// The /api/chat request body, built as the web builds it (components/chat.tsx
// prepareSendMessagesRequest; code map §1) plus the mobile's search settings,
// except that isNewChat survives a first submit that failed (see below). Never the conversation (the server loads it), a
// model (signed-in users get their saved preference) or an analytics id.
import type { UIMessage } from 'ai'

import type { SearchMode, SearchSources } from '@/lib/types/search'

/** The search settings each turn sends. Task 6 persists them. */
export type SearchSettings = { searchMode: SearchMode; sources: SearchSources }

export type ChatBodyInput = {
  /** The SDK's trigger: 'submit-message' or 'regenerate-message'. */
  trigger: string
  chatId: string
  /** The SDK's message id: the message a regenerate targets. */
  messageId?: string
  /** The conversation as the SDK sends it (already cut for a regenerate). */
  messages: UIMessage[]
  /** The chat had no saved messages when it was opened. */
  isNewChat: boolean
  settings: SearchSettings
}

export function buildChatBody({
  trigger,
  chatId,
  messageId,
  messages,
  isNewChat,
  settings
}: ChatBodyInput): Record<string, unknown> {
  const target =
    trigger === 'regenerate-message'
      ? messages.find(m => m.id === messageId)
      : undefined
  return {
    trigger,
    chatId,
    messageId,
    // Regenerating from a user message resends it; regenerating an answer
    // sends none (the server deletes from that answer on and answers again).
    message:
      target?.role === 'user'
        ? target
        : trigger === 'submit-message'
          ? messages[messages.length - 1]
          : undefined,
    // A brand-new chat is created by its first submit that gets through, so
    // it stays new until an answer has arrived. The server tolerates a chat
    // that already exists (persist-stream-results.ts duplicate-key fallback)
    // but refuses a non-new turn on a chat that doesn't (403).
    isNewChat:
      isNewChat &&
      trigger === 'submit-message' &&
      !messages.some(m => m.role === 'assistant'),
    searchMode: settings.searchMode,
    sources: settings.sources
  }
}
