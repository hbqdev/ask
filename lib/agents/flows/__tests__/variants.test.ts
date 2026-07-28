import { describe, expect, it } from 'vitest'

import { countToolCalls, type FlowStep, hasEmittedText } from '../types'
import {
  DEFAULT_FLOW_VARIANT,
  FLOW_VARIANTS,
  resolveFlowVariant
} from '../variants'

const step = (...tools: string[]): FlowStep => ({
  toolCalls: tools.map(toolName => ({ toolName }))
})

describe('resolveFlowVariant', () => {
  it('defaults to baseline when unset', () => {
    expect(resolveFlowVariant(undefined).id).toBe(DEFAULT_FLOW_VARIANT)
    expect(resolveFlowVariant('').id).toBe(DEFAULT_FLOW_VARIANT)
  })

  it('falls back to baseline for an unknown id rather than crashing a turn', () => {
    // A typo in FLOW_VARIANT must degrade to the control arm, not 500 the
    // chat route — this runs on every request.
    expect(resolveFlowVariant('does-not-exist').id).toBe(DEFAULT_FLOW_VARIANT)
  })

  it('resolves every registered variant', () => {
    for (const id of Object.keys(FLOW_VARIANTS)) {
      expect(resolveFlowVariant(id).id).toBe(id)
    }
  })
})

describe('baseline is genuinely a no-op', () => {
  // It is the control arm. If it quietly reshaped anything, every other arm's
  // delta would be measured against the wrong thing.
  const b = FLOW_VARIANTS.baseline
  it('overrides nothing', () => {
    expect(b.buildPrompt).toBeUndefined()
    expect(b.prepareStep).toBeUndefined()
    expect(b.shouldStop).toBeUndefined()
    expect(b.maxSteps).toBeUndefined()
  })
})

describe('adaptive', () => {
  const v = FLOW_VARIANTS.adaptive
  const prompt = v.buildPrompt!({
    basePrompt: 'IGNORED',
    searchMode: 'balanced',
    skipSearch: false,
    hasUrl: false
  })

  it('drops the mandatory-search rule', () => {
    expect(prompt).not.toMatch(/MUST run at least one search/i)
    expect(prompt).not.toMatch(/FIRST action in every turn/i)
  })

  it('keeps the grounding property that rule was protecting', () => {
    // Removing the mandate without this would trade a latency problem for a
    // hallucination problem.
    expect(prompt).toMatch(/answering from your own knowledge/i)
    expect(prompt).toMatch(
      /NEVER write a citation anchor for a source you did not/i
    )
  })

  it('does not force or forbid tools in code — the model must decide', () => {
    expect(v.prepareStep).toBeUndefined()
  })

  it('replaces the base prompt rather than appending to it', () => {
    expect(prompt).not.toContain('IGNORED')
  })
})

describe('react-gap', () => {
  const v = FLOW_VARIANTS['react-gap']

  it('leaves step 0 free but re-injects the gap check afterwards', () => {
    // Not sticky in the SDK, so it has to be re-sent every step.
    expect(
      v.prepareStep!({ stepNumber: 0, steps: [], skipSearch: false })
    ).toEqual({})
    const later = v.prepareStep!({
      stepNumber: 3,
      steps: [step('search')],
      skipSearch: false
    })
    expect(later.system).toMatch(/what is still missing/i)
  })

  it('re-appends output rules to the injected system prompt', () => {
    // A per-step `system` REPLACES instructions, so anything omitted is lost
    // mid-turn — the answer format included.
    const later = v.prepareStep!({
      stepNumber: 1,
      steps: [],
      skipSearch: false
    })
    expect(later.system).toMatch(/## /)
  })

  it('reports progress from real tool counts', () => {
    expect(
      v.stepStatus!({ stepNumber: 0, steps: [], skipSearch: false })
    ).toMatch(/assessing/i)
    const s = v.stepStatus!({
      stepNumber: 2,
      steps: [step('search'), step('fetch', 'fetch')],
      skipSearch: false
    })
    expect(s).toContain('1 search')
    expect(s).toContain('2 pages read')
  })
})

describe('plan-execute', () => {
  const v = FLOW_VARIANTS['plan-execute']

  it('FORCES the plan on step 0', () => {
    // Prompting for a plan is exactly what quality mode already does and the
    // model skips it when the question looks easy, so this one is enforced.
    expect(
      v.prepareStep!({ stepNumber: 0, steps: [], skipSearch: false }).toolChoice
    ).toEqual({
      type: 'tool',
      toolName: 'todoWrite'
    })
  })

  it('switches to an execution prompt afterwards and stops forcing', () => {
    const later = v.prepareStep!({
      stepNumber: 1,
      steps: [],
      skipSearch: false
    })
    expect(later.toolChoice).toBeUndefined()
    expect(later.system).toMatch(/execute your plan/i)
  })
})

describe('wide-once', () => {
  const v = FLOW_VARIANTS['wide-once']

  it('forces exactly one search, then removes every tool', () => {
    expect(
      v.prepareStep!({ stepNumber: 0, steps: [], skipSearch: false }).toolChoice
    ).toEqual({
      type: 'tool',
      toolName: 'search'
    })
    const after = v.prepareStep!({
      stepNumber: 1,
      steps: [step('search')],
      skipSearch: false
    })
    // Emptying activeTools is the termination mechanism, not a side effect: a
    // step with no tool calls ends the turn.
    expect(after.activeTools).toEqual([])
    expect(after.toolChoice).toBe('none')
  })

  it('tells the model to admit gaps rather than guess', () => {
    const prompt = v.buildPrompt!({
      basePrompt: '',
      searchMode: 'balanced',
      skipSearch: false,
      hasUrl: false
    })
    expect(prompt).toMatch(/state plainly what could not be verified/i)
    expect(prompt).toMatch(/Do not guess/i)
  })
})

describe('every non-baseline variant keeps the shared contracts', () => {
  // These are the properties that make arms comparable. A variant that
  // silently dropped citation rules would win on latency for the wrong reason.
  for (const [id, v] of Object.entries(FLOW_VARIANTS)) {
    if (id === 'baseline') continue
    it(`${id} keeps citation and output rules`, () => {
      const p = v.buildPrompt!({
        basePrompt: '',
        searchMode: 'balanced',
        skipSearch: false,
        hasUrl: false
      })
      expect(p).toMatch(/\[number\]\(#toolCallId\)/)
      expect(p).toMatch(/ONLY toolCallIds from tools you actually called/i)
      expect(p).toMatch(/must START with a `## ` heading/i)
    })
  }
})

describe('step helpers', () => {
  it('counts by tool name and in total', () => {
    const steps = [step('search'), step('fetch', 'search'), step()]
    expect(countToolCalls(steps)).toBe(3)
    expect(countToolCalls(steps, 'search')).toBe(2)
    expect(countToolCalls(steps, 'todoWrite')).toBe(0)
  })

  it('detects that an answer has begun', () => {
    expect(hasEmittedText([{ text: '' }, { text: '   ' }])).toBe(false)
    expect(hasEmittedText([{ text: '' }, { text: '## Answer' }])).toBe(true)
  })
})
