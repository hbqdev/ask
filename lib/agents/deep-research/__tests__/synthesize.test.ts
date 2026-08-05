import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockGenerateText = vi.hoisted(() => vi.fn())

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: mockGenerateText }
})
vi.mock('../../../utils/registry', () => ({
  getModel: vi.fn(() => 'mock-language-model')
}))

import type { SearchResultItem } from '../../../types'
import { getModel } from '../../../utils/registry'
import { SYNTHESIS_TOOL_CALL_ID } from '../citations'
import type { SubAgentResult } from '../sub-agent'
import { synthesizeReport } from '../synthesize'

const src = (url: string): SearchResultItem =>
  ({ url, title: url, content: '' }) as SearchResultItem

const twoSubs: SubAgentResult[] = [
  {
    subtask: { title: 'A', query: 'qa', rationale: 'ra' },
    report: 'Finding one [1](#tcA).',
    citationMaps: { tcA: { 1: src('u1') } }
  },
  {
    subtask: { title: 'B', query: 'qb', rationale: 'rb' },
    report: 'Finding two [1](#tcB).',
    citationMaps: { tcB: { 1: src('u2') } }
  }
]

beforeEach(() => {
  mockGenerateText.mockReset()
  vi.mocked(getModel).mockReturnValue('mock-language-model')
})

describe('synthesizeReport', () => {
  test('anchors the model output over the unified source space', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'Synthesis citing [1] and [2].'
    })

    const res = await synthesizeReport({
      question: 'the question',
      subResults: twoSubs,
      modelId: 'm'
    })

    expect(res.report).toBe(
      `Synthesis citing [1](#${SYNTHESIS_TOOL_CALL_ID}) and [2](#${SYNTHESIS_TOOL_CALL_ID}).`
    )
    expect(res.sources.map(s => s.url)).toEqual(['u1', 'u2'])
    expect(res.citationMaps[SYNTHESIS_TOOL_CALL_ID][2].url).toBe('u2')
  })

  test('fails open to stitched sub-reports when the model errors', async () => {
    // Throw synchronously inside the try (via getModel) so the fail-open catch
    // runs without surfacing an unhandled rejection in the test runner.
    vi.mocked(getModel).mockImplementationOnce(() => {
      throw new Error('model down')
    })

    const res = await synthesizeReport({
      question: 'q',
      subResults: twoSubs,
      modelId: 'm'
    })

    // Stitched fallback keeps each sub-report under its title, anchored.
    expect(res.report).toContain('## A')
    expect(res.report).toContain('## B')
    expect(res.report).toContain(`[1](#${SYNTHESIS_TOOL_CALL_ID})`)
    expect(res.report).toContain(`[2](#${SYNTHESIS_TOOL_CALL_ID})`)
  })

  test('falls back when the model returns only citations/whitespace', async () => {
    mockGenerateText.mockResolvedValue({ text: '  [1]  ' })

    const res = await synthesizeReport({
      question: 'q',
      subResults: twoSubs,
      modelId: 'm'
    })

    expect(res.report).toContain('Finding one')
    expect(res.report).toContain('Finding two')
  })

  test('returns an empty report when there are no findings', async () => {
    const res = await synthesizeReport({
      question: 'q',
      subResults: [
        {
          subtask: { title: 'A', query: 'q', rationale: 'r' },
          report: '',
          citationMaps: {}
        }
      ],
      modelId: 'm'
    })

    expect(res.report).toBe('')
    expect(mockGenerateText).not.toHaveBeenCalled()
  })
})
