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
}
