// What each research part shows as a step in the thread's research process,
// and the collapsed summary line. Pure: no React.
import type { UIMessage } from 'ai'

import { isGeneratedImagePart } from '@/lib/render/message-parts'
import { normalizeFetchUrls } from '@/lib/schema/fetch'

type Part = UIMessage['parts'][number]

export type ResearchStep = {
  kind:
    | 'search'
    | 'fetch'
    | 'reasoning'
    | 'classify'
    | 'recall'
    | 'documents'
    | 'tool'
  label: string
  detail?: string
  done: boolean
}

/**
 * A tool call in either shape: live it streams as `tool-<name>`; a reloaded
 * turn rehydrates most tools as `dynamic-tool` carrying `toolName`. Input and
 * output may be missing or partial while the call streams.
 */
type ToolCall = {
  toolName: string
  state?: string
  input?: Record<string, unknown>
  output?: Record<string, unknown>
}

const REASONING_PREVIEW_CHARS = 140

function asToolCall(part: Part): ToolCall | null {
  const p = part as {
    type: string
    toolName?: string
    state?: string
    input?: unknown
    output?: unknown
  }
  let toolName: string | undefined
  if (p.type === 'dynamic-tool') toolName = p.toolName
  else if (p.type.startsWith('tool-')) toolName = p.type.slice('tool-'.length)
  if (!toolName) return null
  return {
    toolName,
    state: p.state,
    input: asRecord(p.input),
    output: asRecord(p.output)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Finished once it has a final output or an error. search and fetch first
 * yield a preliminary `searching`/`fetching` output, which arrives as
 * `output-available` too, so that alone does not mean the call finished.
 */
function isToolDone(call: ToolCall): boolean {
  if (call.state === 'output-error') return true
  if (call.state !== 'output-available') return false
  const progress = call.output?.state
  return progress !== 'searching' && progress !== 'fetching'
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function describeSearch(call: ToolCall): ResearchStep {
  const query = call.input?.query
  const results = call.output?.results
  const step: ResearchStep = {
    kind: 'search',
    label: typeof query === 'string' && query.trim() ? query : 'Searching',
    done: isToolDone(call)
  }
  if (call.state === 'output-available' && Array.isArray(results)) {
    step.detail = plural(results.length, 'result', 'results')
  }
  return step
}

function describeFetch(call: ToolCall): ResearchStep {
  const raw = call.input?.url
  const urls =
    typeof raw === 'string' || Array.isArray(raw)
      ? normalizeFetchUrls(raw as string | string[])
      : []
  const step: ResearchStep = {
    kind: 'fetch',
    label: urls.length > 0 ? hostnameOf(urls[0]) : 'Reading a page',
    done: isToolDone(call)
  }
  if (urls.length > 1) step.detail = `+${urls.length - 1} more`
  return step
}

function describeTool(call: ToolCall): ResearchStep {
  switch (call.toolName) {
    case 'search':
      return describeSearch(call)
    case 'fetch':
      return describeFetch(call)
    case 'documentRetrieval':
      return {
        kind: 'documents',
        label: 'Reading your documents',
        done: isToolDone(call)
      }
    default:
      return { kind: 'tool', label: call.toolName, done: isToolDone(call) }
  }
}

/**
 * The step a research part shows, for live `tool-<name>` and reloaded
 * `dynamic-tool` parts alike, or null for a part that is not shown as a step.
 */
export function describeResearchStep(part: Part): ResearchStep | null {
  switch (part.type) {
    case 'reasoning': {
      const preview = part.text.trim().slice(0, REASONING_PREVIEW_CHARS)
      const step: ResearchStep = {
        kind: 'reasoning',
        label: 'Thinking',
        done: true
      }
      if (preview) step.detail = preview
      return step
    }
    case 'data-classifier': {
      const data = part.data as { state?: string } | undefined
      return {
        kind: 'classify',
        label: 'Understanding the question',
        done: data?.state === 'done'
      }
    }
    case 'data-recall': {
      const chats = (part.data as { chats?: unknown[] } | undefined)?.chats
      if (!chats?.length) return null
      return {
        kind: 'recall',
        label: `Recalled ${plural(chats.length, 'chat', 'chats')}`,
        done: true
      }
    }
  }
  if (isGeneratedImagePart(part)) return null
  const call = asToolCall(part)
  return call ? describeTool(call) : null
}

/** The collapsed research line: live, or how many steps it took. */
export function researchSummary(parts: Part[], live: boolean): string {
  if (live) return 'Researching…'
  const steps = parts.filter(p => describeResearchStep(p) !== null).length
  return `Completed ${plural(steps, 'step', 'steps')}`
}

/** The chat title the server streamed into this message, if any. */
export function titleOf(message: UIMessage): string | undefined {
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part.type === 'data-title') {
      return (part.data as { title?: string } | undefined)?.title
    }
  }
  return undefined
}
