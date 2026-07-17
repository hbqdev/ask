import type { ReasoningPart, TextPart } from '@ai-sdk/provider-utils'
import type { InferUITool, UIMessage as AIMessage } from 'ai'

import { fetchTool } from '@/lib/tools/fetch'
import { askQuestionTool } from '@/lib/tools/question'
import { searchTool } from '@/lib/tools/search'
import { createTodoTools, type TodoItem } from '@/lib/tools/todo'
import type { SearchMode } from '@/lib/types/search'

// Re-export TodoItem for external use
export type { TodoItem }

// Define metadata type for messages
export interface UIMessageMetadata {
  traceId?: string
  feedbackScore?: number | null
  searchMode?: SearchMode
  modelId?: string
  [key: string]: any
}

export type UIMessage<
  TMetadata = UIMessageMetadata,
  TDataTypes = UIDataTypes,
  TTools = UITools
> = AIMessage

export type UIDataTypes = {
  sources?: any[]
  // User-authored attachments (composer): a pasted text blob and a pasted URL.
  pastedContent?: { text: string }
  quotedContext?: { text: string }
  sourceUrl?: { url: string }
  // Streamed by create-chat-stream-response.ts while the query classifier
  // decides whether this turn needs a fresh search — rendered as a step in
  // the research-process list (components/classifier-section.tsx). The
  // `running` part is overwritten in place (same part id) by the `done` one.
  classifier?:
    | { state: 'running' }
    | {
        state: 'done'
        skipSearch: boolean
        standaloneQuery?: string
        durationMs?: number
      }
  // Streamed by create-chat-stream-response.ts as soon as the generated chat
  // title resolves — which happens seconds in, in parallel with the answer.
  // Without this the client never learns the title: it is only persisted in
  // onFinish (after the whole 30-90s answer), so the header would keep showing
  // "Untitled" until a navigation refetched the chat. Consumed by chat.tsx.
  title?: { title: string }
  // Streamed while uploaded files are prepared for the model (PDF RAG /
  // text extraction, image base64 encoding) — see transformFileParts.
  // Rendered by components/attachments-section.tsx.
  attachments?:
    | { state: 'running'; count: number }
    | { state: 'done'; count: number; durationMs?: number }
}

// Create todo tools instance for type inference
const todoTools = createTodoTools()

export type UITools = {
  search: InferUITool<typeof searchTool>
  fetch: InferUITool<typeof fetchTool>
  askQuestion: InferUITool<typeof askQuestionTool>
  todoWrite: InferUITool<typeof todoTools.todoWrite>
  // Dynamic tools will be added at runtime
  [key: string]: any
}

export type ToolPart<T extends keyof UITools = keyof UITools> = {
  type: `tool-${T}`
  toolCallId: string
  input: UITools[T]['input']
  output?: UITools[T]['output']
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
  errorText?: string
}

export type Part = TextPart | ReasoningPart | ToolPart
