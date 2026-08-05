import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockGenerateText = vi.hoisted(() => vi.fn())

vi.mock('ai', async importOriginal => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: mockGenerateText }
})
vi.mock('../../../utils/registry', () => ({
  getModel: vi.fn(() => 'mock-language-model')
}))

import { getModel } from '../../../utils/registry'
import { planResearch } from '../planner'

beforeEach(() => mockGenerateText.mockReset())

describe('planResearch', () => {
  test('returns the planned subtasks on success', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        subtasks: [
          { title: 'Background', query: 'q-a', rationale: 'r-a' },
          { title: 'Recent', query: 'q-b', rationale: 'r-b' }
        ]
      }
    })
    const plan = await planResearch({ question: 'a big question', modelId: 'm' })
    expect(plan.degraded).toBe(false)
    expect(plan.subtasks.map(s => s.query)).toEqual(['q-a', 'q-b'])
  })

  test('trims fields and drops subtasks with an empty query', async () => {
    mockGenerateText.mockResolvedValue({
      output: {
        subtasks: [
          { title: ' T ', query: ' q1 ', rationale: ' r ' },
          { title: 'x', query: '   ', rationale: 'y' }
        ]
      }
    })
    const plan = await planResearch({ question: 'q', modelId: 'm' })
    expect(plan.subtasks).toHaveLength(1)
    expect(plan.subtasks[0]).toEqual({ title: 'T', query: 'q1', rationale: 'r' })
  })

  test('fails OPEN to a single whole-question angle when the model layer errors', async () => {
    // getModel() is evaluated inside the try (as the generateText arg), so a
    // failure there exercises the same fail-open catch as a model rejection.
    vi.mocked(getModel).mockImplementationOnce(() => {
      throw new Error('model down')
    })
    const plan = await planResearch({ question: 'the question', modelId: 'm' })
    expect(plan.degraded).toBe(true)
    expect(plan.subtasks).toHaveLength(1)
    expect(plan.subtasks[0].query).toBe('the question')
  })

  test('fails open when the model returns no usable subtasks', async () => {
    mockGenerateText.mockResolvedValue({ output: { subtasks: [] } })
    const plan = await planResearch({ question: 'q', modelId: 'm' })
    expect(plan.degraded).toBe(true)
    expect(plan.subtasks).toHaveLength(1)
  })

  test('short-circuits an empty question without calling the model', async () => {
    const plan = await planResearch({ question: '   ', modelId: 'm' })
    expect(plan.degraded).toBe(true)
    expect(mockGenerateText).not.toHaveBeenCalled()
  })
})
