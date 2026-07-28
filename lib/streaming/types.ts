import { UIMessage } from '@ai-sdk/react'

import { Model } from '../types/models'
import { SearchMode, SearchSources } from '../types/search'

export interface BaseStreamConfig {
  /**
   * Milliseconds since epoch at ROUTE ENTRY, used as the origin for the
   * turn's retrieval budget (lib/agents/turn-budget.ts). It must be taken in
   * the route rather than downstream: the budget has to share a clock with the
   * route's hard abort, and body parse, auth, message conversion, the
   * context-window probe, the classifier and recall all run in between.
   * Measured at up to 83s of preamble, which moved the deadline from 210s to
   * 293s of route time and left no room to write an answer.
   */
  turnStartedAt?: number
  message: UIMessage | null
  model: Model
  chatId: string
  userId: string
  trigger?: 'submit-user-message' | 'regenerate-assistant-message'
  messageId?: string
  abortSignal?: AbortSignal
  isNewChat?: boolean
  searchMode?: SearchMode
  sources?: SearchSources
  systemInstructions?: string
}
