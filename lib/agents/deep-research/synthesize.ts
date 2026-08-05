import { generateText } from 'ai'

import type { SearchResultItem } from '../../types'
import { getModel } from '../../utils/registry'

import {
  anchorSynthesizedCitations,
  mergeCitations,
  type MergedCitations
} from './citations'
import type { SubAgentResult } from './sub-agent'

const SYNTH_SYSTEM = `You are the lead researcher writing the FINAL report for a deep-research question. Your team of sub-researchers investigated separate angles; their findings are given to you, already sharing one numbered Sources list.

Write a single, coherent, well-structured report that directly and thoroughly answers the question. Requirements:
- Synthesize ACROSS the findings — connect, compare, and resolve tensions between angles. Do not just concatenate the sub-reports.
- Use markdown: a short lead paragraph, then \`##\` sections as the material warrants.
- Cite every factual claim inline as [N], where N is a number from the Sources list. You may cite multiple: [3][7].
- NEVER cite a number that is not in the Sources list, and never invent sources or facts. If the findings don't cover something, say so briefly rather than guessing.
- Be specific and concrete (numbers, names, dates); omit filler and restatements of the question.`

export interface SynthesisResult {
  report: string
  citationMaps: Record<string, Record<number, SearchResultItem>>
  sources: SearchResultItem[]
}

function sourcesBlock(sources: SearchResultItem[]): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title || s.url} — ${s.url}`)
    .join('\n')
}

function findingsBlock(
  reports: MergedCitations['rewrittenReports']
): string {
  return reports
    .filter(r => r.report.trim().length > 0)
    .map(r => `## ${r.subtask.title}\n${r.report.trim()}`)
    .join('\n\n')
}

/** When synthesis can't run, stitch the sub-reports into one anchored document. */
function concatenateFallback(merged: MergedCitations): string {
  const body = findingsBlock(merged.rewrittenReports)
  return anchorSynthesizedCitations(body, merged.sources.length)
}

/**
 * Compose the sub-agents' findings into one cited report over a unified
 * citation space. Fails OPEN: if the model errors or returns nothing usable,
 * returns the sub-reports stitched together (still correctly anchored) so a
 * deep-research turn always produces an answer.
 */
export async function synthesizeReport({
  question,
  subResults,
  modelId,
  abortSignal
}: {
  question: string
  subResults: SubAgentResult[]
  modelId: string
  abortSignal?: AbortSignal
}): Promise<SynthesisResult> {
  const merged = mergeCitations(subResults)
  const base: Omit<SynthesisResult, 'report'> = {
    citationMaps: merged.citationMaps,
    sources: merged.sources
  }

  const findings = findingsBlock(merged.rewrittenReports)
  if (!findings) return { report: '', ...base }

  try {
    const { text } = await generateText({
      model: getModel(modelId, abortSignal),
      system: SYNTH_SYSTEM,
      prompt: `Question: ${question}\n\nSources:\n${sourcesBlock(merged.sources) || '(none)'}\n\nFindings from the research team:\n${findings}`,
      temperature: 0.3,
      abortSignal
    })
    const report = anchorSynthesizedCitations(
      text.trim(),
      merged.sources.length
    )
    // A model that returned only whitespace/citations is no better than the
    // stitched fallback — prefer the fallback's real content in that case.
    if (report.replace(ANCHORED_CITATION_RE, '').trim().length === 0) {
      return { report: concatenateFallback(merged), ...base }
    }
    return { report, ...base }
  } catch {
    return { report: concatenateFallback(merged), ...base }
  }
}

// Used only to check whether a synthesized report has substance beyond anchors.
const ANCHORED_CITATION_RE = /\[\s*\d+\s*\]\(#[^)]+\)/g
