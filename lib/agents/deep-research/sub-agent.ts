import { createUIMessageStream } from 'ai'

import type { UIMessage } from '@/lib/types/ai'

import { stripNarrationFromMessage } from '../../streaming/helpers/strip-narration-from-message'
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

export interface CollectedResearch {
  report: string
  citationMaps: Record<string, Record<number, SearchResultItem>>
}

/**
 * Run a researcher to completion and collect its report text + citation maps.
 * The shared core behind both a deep-research sub-agent and the single-agent
 * baseline — reuses all of `createResearcher` (search, crawl, rerank, cite) and
 * drives it via a throwaway UI stream, capturing the assembled message.
 */
export async function runResearcherCollected({
  query,
  modelId,
  modelConfig,
  searchMode,
  sources = ['web'],
  systemInstructions,
  abortSignal
}: {
  query: string
  modelId: string
  modelConfig?: Model
  searchMode: SearchMode
  sources?: SearchSources
  systemInstructions?: string
  abortSignal?: AbortSignal
}): Promise<CollectedResearch> {
  const agent = await createResearcher({
    model: modelId,
    modelConfig,
    searchMode,
    sources,
    standaloneQuery: query,
    systemInstructions,
    abortSignal
  })

  let responseMessage: UIMessage | undefined
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const result = await agent.stream({
        messages: [{ role: 'user', content: query }],
        abortSignal
      })
      writer.merge(result.toUIMessageStream({ sendStart: false }))
    },
    onFinish: ({ responseMessage: msg }) => {
      responseMessage = msg
    }
  })

  // Drain the stream to drive the run to completion; onFinish then holds the
  // assembled message. We don't forward these chunks anywhere — progress
  // streaming to the UI is a later slice.
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }

  // Strip the model's process narration ("Let me search again…") exactly as the
  // production render/persist path does (create-chat-stream-response.ts) — the
  // harness must collect the text a user would actually see, not the raw stream.
  const cleaned = responseMessage
    ? stripNarrationFromMessage(responseMessage)
    : undefined
  return {
    report: textFromMessage(cleaned),
    citationMaps: cleaned ? extractCitationMaps(cleaned) : {}
  }
}

/**
 * Run ONE research sub-agent on a single angle and return its report + sources.
 * The sub-agent is a researcher scoped to one subtask at 'balanced' depth — NOT
 * 'quality', which is Ask's full deep-research protocol (≥15 searches). Running
 * each angle at 'quality' would make multi-agent simply "N× more searching",
 * confounding the A/B; 'balanced' keeps the total budget comparable to the
 * single-agent baseline so the test isolates the value of decomposition.
 */
export async function runSubAgent({
  subtask,
  modelId,
  modelConfig,
  sources = ['web'],
  subSearchMode = 'balanced',
  abortSignal
}: {
  subtask: ResearchSubtask
  modelId: string
  modelConfig?: Model
  sources?: SearchSources
  subSearchMode?: SearchMode
  abortSignal?: AbortSignal
}): Promise<SubAgentResult> {
  const collected = await runResearcherCollected({
    query: subtask.query,
    modelId,
    modelConfig,
    searchMode: subSearchMode,
    sources,
    systemInstructions: `You are ONE sub-researcher in a deep-research team. Research ONLY this angle, thoroughly: "${subtask.title}". ${subtask.rationale}
Report concrete, specific findings with inline citations. Do not restate the broader question or the other angles — cover just this one well.`,
    abortSignal
  })
  return { subtask, ...collected }
}
