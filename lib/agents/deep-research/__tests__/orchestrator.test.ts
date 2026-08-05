import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockPlan = vi.hoisted(() => vi.fn())
const mockRunSubAgent = vi.hoisted(() => vi.fn())

vi.mock('../planner', () => ({ planResearch: mockPlan }))
vi.mock('../sub-agent', () => ({ runSubAgent: mockRunSubAgent }))

import { runDeepResearch } from '../orchestrator'

beforeEach(() => {
  mockPlan.mockReset()
  mockRunSubAgent.mockReset()
})

const twoAngles = {
  degraded: false,
  subtasks: [
    { title: 'A', query: 'qa', rationale: 'ra' },
    { title: 'B', query: 'qb', rationale: 'rb' }
  ]
}

describe('runDeepResearch', () => {
  test('plans, fans out to sub-agents, returns reports and calls onPlan', async () => {
    mockPlan.mockResolvedValue(twoAngles)
    mockRunSubAgent.mockImplementation(async ({ subtask }) => ({
      subtask,
      report: `report ${subtask.title}`,
      citationMaps: {}
    }))
    const onPlan = vi.fn()

    const res = await runDeepResearch({ question: 'q', modelId: 'm', onPlan })

    expect(onPlan).toHaveBeenCalledWith(twoAngles)
    expect(res.plan).toBe(twoAngles)
    expect(mockRunSubAgent).toHaveBeenCalledTimes(2)
    expect(res.subResults.map(r => r.report).sort()).toEqual([
      'report A',
      'report B'
    ])
  })

  test('drops sub-agents that fail, keeps the successful ones', async () => {
    mockPlan.mockResolvedValue(twoAngles)
    mockRunSubAgent.mockImplementation(async ({ subtask }) => {
      if (subtask.title === 'A') throw new Error('sub A failed')
      return { subtask, report: 'report B', citationMaps: {} }
    })

    const res = await runDeepResearch({ question: 'q', modelId: 'm' })

    expect(res.subResults.map(r => r.subtask.title)).toEqual(['B'])
  })
})
