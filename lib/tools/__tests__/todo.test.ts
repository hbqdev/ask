import { afterEach, describe, expect, it, vi } from 'vitest'

import { completeTodos, createTodoTools, todoWriteInputSchema } from '../todo'

// The exact item shape kimi-k2.6 sent on the lab (message xCUYP2uzrbdiFz1T,
// 2026-09-29): no `timestamp`, so the whole call failed validation.
const LAB_INPUT = {
  todos: [
    {
      content: 'Summarize cardiovascular evidence (SELECT, SOUL, SUMMIT)',
      id: '1',
      priority: 'high',
      status: 'completed'
    },
    {
      content: 'Summarize kidney/CKD evidence (FLOW trial)',
      id: '2',
      priority: 'high',
      status: 'in_progress'
    }
  ]
}

async function write(
  tools: ReturnType<typeof createTodoTools>,
  input: unknown
): Promise<any> {
  const parsed = todoWriteInputSchema.parse(input)
  return tools.todoWrite.execute!(parsed, {} as any)
}

describe('todoWrite', () => {
  afterEach(() => vi.useRealTimers())

  it('accepts todos without timestamp or id (both server-filled)', () => {
    expect(todoWriteInputSchema.safeParse(LAB_INPUT).success).toBe(true)
    // A retry on staging (ctjt5ZObPyG1jMjb) added timestamps but dropped ids.
    const noIds = {
      todos: [{ content: 'Compare RAID', status: 'pending' }]
    }
    expect(todoWriteInputSchema.safeParse(noIds).success).toBe(true)
  })

  it('still requires content and status', () => {
    expect(
      todoWriteInputSchema.safeParse({
        todos: [{ id: '1', status: 'pending' }]
      }).success
    ).toBe(false)
    expect(
      todoWriteInputSchema.safeParse({ todos: [{ id: '1', content: 'x' }] })
        .success
    ).toBe(false)
  })

  it('fills timestamp (ISO, now), a positional id and the default priority', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T06:08:58.000Z'))
    const out = await write(createTodoTools(), {
      todos: [
        { content: 'First', status: 'pending' },
        { content: 'Second', status: 'completed', id: 'b' }
      ]
    })
    expect(out.todos).toEqual([
      {
        id: '1',
        content: 'First',
        status: 'pending',
        priority: 'medium',
        timestamp: '2026-09-29T06:08:58.000Z'
      },
      {
        id: 'b',
        content: 'Second',
        status: 'completed',
        priority: 'medium',
        timestamp: '2026-09-29T06:08:58.000Z'
      }
    ])
    expect(out.completedCount).toBe(1)
    expect(out.totalCount).toBe(2)
  })

  it('keeps each todo’s creation time across rewrites of the list', async () => {
    vi.useFakeTimers()
    const tools = createTodoTools()
    vi.setSystemTime(new Date('2026-09-29T06:00:00.000Z'))
    await write(tools, LAB_INPUT)
    vi.setSystemTime(new Date('2026-09-29T06:05:00.000Z'))
    const out = await write(tools, {
      todos: [
        ...LAB_INPUT.todos.map(t => ({ ...t, status: 'completed' })),
        { id: '3', content: 'Summarize addiction evidence', status: 'pending' }
      ]
    })
    expect(out.todos.map((t: any) => t.timestamp)).toEqual([
      '2026-09-29T06:00:00.000Z',
      '2026-09-29T06:00:00.000Z',
      '2026-09-29T06:05:00.000Z'
    ])
  })

  it('keeps an id and timestamp the model did send', () => {
    const [todo] = completeTodos(
      [
        {
          id: 'x',
          content: 'c',
          status: 'pending',
          priority: 'low',
          timestamp: '2026-07-27T00:00:00Z'
        }
      ],
      [],
      '2026-09-29T00:00:00.000Z'
    )
    expect(todo).toEqual({
      id: 'x',
      content: 'c',
      status: 'pending',
      priority: 'low',
      timestamp: '2026-07-27T00:00:00Z'
    })
  })
})
