import { createUIMessageStream } from 'ai'

import type { UIMessage } from '@/lib/types/ai'

import { stripNarrationPreamble } from '../../streaming/helpers/strip-narration-preamble'
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

type TextPart = { type: 'text'; text: string }

function isTextPart(p: unknown): p is TextPart {
  return (
    (p as { type?: string }).type === 'text' &&
    typeof (p as { text?: unknown }).text === 'string'
  )
}

function joinTextParts(parts: readonly unknown[], separator = ''): string {
  return parts
    .filter(isTextPart)
    .map(p => p.text)
    .join(separator)
    .trim()
}

/** Concatenate ALL text parts (process narration included). Kept for the
 * no-tool fallback and unit tests. */
export function textFromMessage(message: UIMessage | undefined): string {
  if (!message?.parts) return ''
  return joinTextParts(message.parts)
}

/**
 * The FINAL-ANSWER text of a researcher turn: the text parts AFTER the last
 * tool call (the model's written answer) — everything before it is inter-step
 * process narration ("Let me search again…"). Mirrors production's
 * answer-vs-narration split (memory/extract-indexable-text.ts) and the render
 * path, but PRESERVES inline citations, which extractIndexableText strips for
 * embeddings and we need for the report + judge. Falls back to the last
 * heading-led text part when a tool part trails the answer (the follow-up
 * questions tool-dynamic), then strips any same-part narration preamble.
 */
export function finalReportText(message: UIMessage | undefined): string {
  const parts = message?.parts
  if (!parts || parts.length === 0) return ''

  let lastToolIndex = -1
  parts.forEach((p, i) => {
    const type = (p as { type?: string }).type
    if (typeof type === 'string' && type.startsWith('tool-')) lastToolIndex = i
  })

  let relevant: readonly unknown[] =
    lastToolIndex === -1 ? parts : parts.slice(lastToolIndex + 1)

  // Answer trailed by a tool part → nothing after the last tool; recover the
  // last text part if it starts with a markdown heading (the enforced answer
  // first-token rule that distinguishes a real answer from pure narration).
  if (lastToolIndex !== -1 && joinTextParts(relevant).length === 0) {
    const texts = parts.filter(isTextPart)
    const last = texts[texts.length - 1]
    if (last && /^#{1,6}\s/.test(last.text.trimStart())) relevant = [last]
  }

  return stripNarrationPreamble(joinTextParts(relevant, '\n\n'))
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

  // Collect the FINAL answer (text after the last tool call), NOT the raw
  // concatenation of every inter-step narration part — matching what production
  // treats as the answer. Citations preserved for the judge and the merge.
  return {
    report: finalReportText(responseMessage) || textFromMessage(responseMessage),
    citationMaps: responseMessage ? extractCitationMaps(responseMessage) : {}
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
