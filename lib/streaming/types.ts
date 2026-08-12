import { UIMessage } from '@ai-sdk/react'

import { Model } from '../types/models'
import { SearchMode, SearchSources } from '../types/search'

export interface BaseStreamConfig {
  message: UIMessage | null
  model: Model
  chatId: string
  userId: string
  trigger?: 'submit-user-message' | 'regenerate-assistant-message'
  messageId?: string
  abortSignal?: AbortSignal
  // The turn's kill controller (in-memory Stop registry). Unregistered in
  // onFinish so the map doesn't leak.
  stopController?: AbortController | null
  isNewChat?: boolean
  searchMode?: SearchMode
  sources?: SearchSources
  systemInstructions?: string
  // Voice "read-aloud" turn: when true (and voice is enabled server-side), the
  // finished answer is condensed into a spoken gist and streamed as a
  // data-spokenGist part. Absent/false ⇒ the turn behaves exactly as before.
  voice?: boolean
}
