import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockRunDeepResearch = vi.hoisted(() => vi.fn())
const mockSynthesize = vi.hoisted(() => vi.fn())
const mockRunResearcherCollected = vi.hoisted(() => vi.fn())

vi.mock('../orchestrator', () => ({ runDeepResearch: mockRunDeepResearch }))
vi.mock('../synthesize', () => ({ synthesizeReport: mockSynthesize }))
vi.mock('../sub-agent', () => ({
  runResearcherCollected: mockRunResearcherCollected
}))

import {
  runMultiAgentDeepResearch,
  runSingleAgentDeepResearch
} from '../index'

beforeEach(() => {
  mockRunDeepResearch.mockReset()
  mockSynthesize.mockReset()
  mockRunResearcherCollected.mockReset()
})

describe('runMultiAgentDeepResearch', () => {
  test('threads the plan through and returns the synthesized answer', async () => {
    const plan = {
      degraded: false,
      subtasks: [{ title: 'A', query: 'q', rationale: 'r' }]
    }
    mockRunDeepResearch.mockResolvedValue({ plan, subResults: [] })
    mockSynthesize.mockResolvedValue({
      report: 'final report',
      citationMaps: { X: { 1: { url: 'u' } } },
      sources: [{ url: 'u', title: 'U' }]
    })

    const res = await runMultiAgentDeepResearch({ question: 'q', modelId: 'm' })

    expect(res.report).toBe('final report')
    expect(res.plan).toBe(plan)
    expect(res.sources).toHaveLength(1)
  })
})

describe('runSingleAgentDeepResearch', () => {
  test('runs at deep-research depth and dedupes sources by URL', async () => {
    mockRunResearcherCollected.mockResolvedValue({
      report: 'baseline report',
      citationMaps: {
        tc1: { 1: { url: 'a', title: 'A' }, 2: { url: 'b', title: 'B' } },
        tc2: { 1: { url: 'b', title: 'B' }, 2: { url: 'c', title: 'C' } }
      }
    })

    const res = await runSingleAgentDeepResearch({ question: 'q', modelId: 'm' })

    expect(res.report).toBe('baseline report')
    expect(res.sources.map(s => s.url)).toEqual(['a', 'b', 'c'])
    expect(mockRunResearcherCollected).toHaveBeenCalledWith(
      expect.objectContaining({ searchMode: 'quality', query: 'q' })
    )
  })
})
