import type { SearchResultItem } from '../../types'

import type { SubAgentResult } from './sub-agent'
import type { ResearchSubtask } from './types'

/**
 * A single synthetic tool-call id that owns the final report's unified citation
 * space. The synthesized answer cites `[N](#deep-research-synthesis)` and the
 * normal render path (`extractCitationMaps` + `processCitations`) resolves it
 * exactly like a real search tool's results.
 */
export const SYNTHESIS_TOOL_CALL_ID = 'deep-research-synthesis'

const ANCHOR_RE = /\[\s*(\d+)\s*\]\(#([^)]+)\)/g
// A bare [N] NOT already an anchor/markdown link — what the synthesizer emits.
const BARE_CITATION_RE = /\[\s*(\d+)\s*\](?!\()/g

// Mirror citation.ts's prefix normalization so a model-prefixed anchor id
// (e.g. `toolu_<id>`) still matches the map keyed by the raw tool-call id.
function stripToolCallPrefix(id: string): string {
  return id.replace(/^(toolu_|call_|search-)/, '')
}

function resolveLocalMap(
  citationMaps: Record<string, Record<number, SearchResultItem>>,
  toolCallId: string
): Record<number, SearchResultItem> | undefined {
  if (citationMaps[toolCallId]) return citationMaps[toolCallId]
  const norm = stripToolCallPrefix(toolCallId)
  const key = Object.keys(citationMaps).find(
    k => stripToolCallPrefix(k) === norm
  )
  return key ? citationMaps[key] : undefined
}

export interface MergedCitations {
  /** Deduped sources in unified order; a source's unified number is index + 1. */
  sources: SearchResultItem[]
  /** citationMaps for the final report: { [SYNTH_ID]: { unifiedN: source } }. */
  citationMaps: Record<string, Record<number, SearchResultItem>>
  /** Each sub-report with its `[localN](#toolCallId)` rewritten to bare `[unifiedN]`. */
  rewrittenReports: { subtask: ResearchSubtask; report: string }[]
}

/**
 * Collapse every sub-agent's independently-numbered citations into ONE unified,
 * URL-deduped space, and rewrite each sub-report's anchors into that space.
 *
 * Pure: no model calls. This is the crux of citation fidelity through
 * synthesis — get the numbering right here and the LLM only has to reuse the
 * numbers it's given.
 */
export function mergeCitations(subResults: SubAgentResult[]): MergedCitations {
  const byUrl = new Map<string, number>() // url -> 1-based unified number
  const sources: SearchResultItem[] = []

  // Pass 1: assign a unified number to each distinct URL, in a stable order
  // (sub-agent order, then ascending citation number within each tool call).
  for (const sub of subResults) {
    for (const localMap of Object.values(sub.citationMaps)) {
      const numbers = Object.keys(localMap)
        .map(Number)
        .sort((a, b) => a - b)
      for (const n of numbers) {
        const src = localMap[n]
        if (!src?.url || byUrl.has(src.url)) continue
        sources.push(src)
        byUrl.set(src.url, sources.length)
      }
    }
  }

  // Pass 2: rewrite each sub-report's anchors to bare unified numbers, dropping
  // any that don't resolve (so the synthesizer never sees a dangling citation).
  const rewrittenReports = subResults.map(sub => ({
    subtask: sub.subtask,
    report: sub.report.replace(ANCHOR_RE, (_whole, numStr, toolCallId) => {
      const localMap = resolveLocalMap(sub.citationMaps, toolCallId)
      const url = localMap?.[Number(numStr)]?.url
      const unified = url ? byUrl.get(url) : undefined
      return unified ? `[${unified}]` : ''
    })
  }))

  const map: Record<number, SearchResultItem> = {}
  sources.forEach((s, i) => {
    map[i + 1] = s
  })

  return {
    sources,
    citationMaps:
      sources.length > 0 ? { [SYNTHESIS_TOOL_CALL_ID]: map } : {},
    rewrittenReports
  }
}

/**
 * Turn the synthesizer's bare `[N]` citations into anchors the render path
 * resolves (`[N](#SYNTH_ID)`), dropping any number outside 1..maxNumber so a
 * hallucinated citation renders as nothing rather than a wrong source.
 */
export function anchorSynthesizedCitations(
  report: string,
  maxNumber: number
): string {
  return report.replace(BARE_CITATION_RE, (_whole, numStr) => {
    const n = Number(numStr)
    if (n >= 1 && n <= maxNumber) return `[${n}](#${SYNTHESIS_TOOL_CALL_ID})`
    return ''
  })
}
