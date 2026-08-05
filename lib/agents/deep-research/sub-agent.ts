import { createUIMessageStream } from 'ai'

import type { UIMessage } from '@/lib/types/ai'

import type { SearchResultItem } from '../../types'
import type { Model } from '../../types/models'
import type { SearchMode, SearchSources } from '../../types/search'
import { extractCitationMaps } from '../../utils/citation'
import { createResearcher } from '../researcher'

import type { ResearchSubtask } from './types'

export interface SubAgentResult {
  subtask: ResearchSubtask
  /** The sub-agent's report text (with its own inline [N](#toolCallId) anchors). */
  report: string
  /** citation number -> source, per toolCallId — for merging into the final report. */
  citationMaps: Record<string, Record<number, SearchResultItem>>
}

/** Concatenate the text parts of an assembled UI message. */
export function textFromMessage(message: UIMessage | undefined): string {
  if (!message?.parts) return ''
  return message.parts
    .filter(
      (p): p is { type: 'text'; text: string } =>
        (p as { type?: string }).type === 'text' &&
        typeof (p as { text?: unknown }).text === 'string'
    )
    .map(p => p.text)
    .join('')
    .trim()
}

/**
 * Run ONE research sub-agent on a single angle and return its report + sources.
 * Reuses the full `createResearcher` machinery (search, crawl, rerank, cite) —
 * the sub-agent is just a normal researcher scoped to one subtask. It runs at a
 * normal depth (`subSearchMode`, default 'quality'), NOT deep-research, so
 * sub-agents don't recurse.
 */
export async function runSubAgent({
  subtask,
  modelId,
  modelConfig,
  sources = ['web'],
  subSearchMode = 'quality',
  abortSignal
}: {
  subtask: ResearchSubtask
  modelId: string
  modelConfig?: Model
  sources?: SearchSources
  subSearchMode?: SearchMode
  abortSignal?: AbortSignal
}): Promise<SubAgentResult> {
  const agent = await createResearcher({
    model: modelId,
    modelConfig,
    searchMode: subSearchMode,
    sources,
    standaloneQuery: subtask.query,
    systemInstructions: `You are ONE sub-researcher in a deep-research team. Research ONLY this angle, thoroughly: "${subtask.title}". ${subtask.rationale}
Report concrete, specific findings with inline citations. Do not restate the broader question or the other angles — cover just this one well.`,
    abortSignal
  })

  let responseMessage: UIMessage | undefined
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const result = await agent.stream({
        messages: [{ role: 'user', content: subtask.query }],
        abortSignal
      })
      writer.merge(result.toUIMessageStream({ sendStart: false }))
    },
    onFinish: ({ responseMessage: msg }) => {
      responseMessage = msg
    }
  })

  // Drain the stream to drive the run to completion; onFinish then holds the
  // assembled message. We don't forward these chunks anywhere — sub-agent
  // progress streaming to the UI is a later slice.
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  return {
    subtask,
    report: textFromMessage(responseMessage),
    citationMaps: responseMessage ? extractCitationMaps(responseMessage) : {}
  }
}
