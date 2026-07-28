import { describe, expect, it, vi } from 'vitest'

import type { FlowVariant } from '@/lib/agents/flows/types'

import { createFlowProgressEmitter } from '../flow-progress'

const writerWith = () => {
  const chunks: Record<string, unknown>[] = []
  return {
    chunks,
    writer: { write: (c: Record<string, unknown>) => chunks.push(c) }
  }
}

const variant = (stepStatus?: FlowVariant['stepStatus']): FlowVariant => ({
  id: 'test',
  summary: 's',
  ...(stepStatus && { stepStatus })
})

describe('createFlowProgressEmitter', () => {
  it('returns null when the variant has no status line', () => {
    // Callers should skip wiring onStepFinish entirely rather than install a
    // no-op that runs on every step of every turn.
    expect(createFlowProgressEmitter(variant(), writerWith().writer)).toBeNull()
  })

  it('emits a complete open/delta/close triple the panel can render', () => {
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(() => 'Searching'),
      writer
    )!
    emit({ stepNumber: 0, steps: [], skipSearch: false })
    expect(chunks.map(c => c.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end'
    ])
    expect(chunks[1].delta).toBe('Searching')
  })

  it('namespaces the part id so it cannot collide with model reasoning', () => {
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(() => 'x'),
      writer
    )!
    emit({ stepNumber: 0, steps: [], skipSearch: false })
    expect(String(chunks[0].id)).toMatch(/^flow-progress-test-0$/)
  })

  it('gives each line a distinct id', () => {
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(({ stepNumber }) => `step ${stepNumber}`),
      writer
    )!
    emit({ stepNumber: 0, steps: [], skipSearch: false })
    emit({ stepNumber: 1, steps: [], skipSearch: false })
    const ids = chunks.filter(c => c.type === 'reasoning-start').map(c => c.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('suppresses a repeated identical line', () => {
    // "Reassessing" three times in a row tells the user nothing and inflates
    // the step counter the panel displays.
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(() => 'same'),
      writer
    )!
    emit({ stepNumber: 0, steps: [], skipSearch: false })
    emit({ stepNumber: 1, steps: [], skipSearch: false })
    emit({ stepNumber: 2, steps: [], skipSearch: false })
    expect(chunks.filter(c => c.type === 'reasoning-start')).toHaveLength(1)
  })

  it('emits nothing when the status line is null', () => {
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(() => null),
      writer
    )!
    emit({ stepNumber: 5, steps: [], skipSearch: false })
    expect(chunks).toHaveLength(0)
  })

  it('never lets a throwing status line break the turn', () => {
    const { chunks, writer } = writerWith()
    const emit = createFlowProgressEmitter(
      variant(() => {
        throw new Error('boom')
      }),
      writer
    )!
    expect(() =>
      emit({ stepNumber: 0, steps: [], skipSearch: false })
    ).not.toThrow()
    expect(chunks).toHaveLength(0)
  })

  it('never lets a throwing writer break the turn', () => {
    const emit = createFlowProgressEmitter(
      variant(() => 'x'),
      {
        write: () => {
          throw new Error('stream closed')
        }
      }
    )!
    expect(() =>
      emit({ stepNumber: 0, steps: [], skipSearch: false })
    ).not.toThrow()
  })
})
