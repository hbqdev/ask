import { describe, expect, it } from 'vitest'

import { buildSearchRoundCapNotice } from '../../tools/search'
import {
  ANSWER_DEADLINE_MS,
  ANSWER_NOW_NOTE,
  answerNowOverrides,
  applyAnswerDeadline
} from '../answer-deadline'
import type { FlowStepOverrides } from '../flows/types'
import { FLOW_VARIANTS } from '../flows/variants'
import {
  answerNowAfterPostCapToolSteps,
  answerNowOnSearchEvasion,
  POST_CAP_TOOL_STEPS_MAX_DEFAULT,
  resolvePostCapToolStepsLimit,
  searchCalledAfterWithdrawal,
  searchCapReached,
  type SearchCapStep,
  toolStepsAfterCap,
  withdrawSearchAfterCap
} from '../search-cap'

// The balanced-mode tool list from createResearcher.
const MODE_TOOLS = [
  'search',
  'fetch',
  'todoWrite',
  'calculate',
  'get_weather',
  'remember',
  'recall'
] as const

// Each output below is the shape steps[].toolResults[].output really carries
// (AI SDK v6: the generator's LAST yield), after every wrapper in the stack.

// lib/tools/search.ts, past the per-turn round cap. wrapSearchToolWithDedup
// re-yields it as `{ ...c, results }`, so the flag survives the wrapper.
const capOutput = {
  state: 'complete',
  results: [],
  images: [],
  query: 'q4',
  number_of_results: 0,
  searchLimitReached: true,
  notice: buildSearchRoundCapNotice(3, false)
}
// lib/tools/search.ts near-duplicate skip: NOT a cap.
const dedupSkipOutput = {
  state: 'complete',
  results: [],
  images: [],
  query: 'q1 again',
  number_of_results: 0,
  note: 'Skipped: this search is a near-duplicate of an earlier search this turn ("q1"). Those results are already above — reuse them, or search a materially different angle instead of rephrasing.'
}
// wrapSearchToolWithDedup exact-repeat short-circuit: NOT a cap.
const duplicateQueryOutput = {
  state: 'complete',
  results: [],
  images: [],
  query: 'q1',
  number_of_results: 0,
  duplicateQuery: true,
  notice: 'You already ran this exact search earlier in this turn; …'
}
// wrapSearchToolWithDedup URL-as-query guidance: NOT a cap.
const urlGuidanceOutput = {
  state: 'complete',
  results: [],
  images: [],
  query: 'https://example.com/a',
  number_of_results: 0,
  notice: '"https://example.com/a" is a URL, not a search query. …'
}
const realOutput = {
  state: 'complete',
  results: [{ title: 'A', url: 'https://example.com/a', content: 'text' }],
  images: [],
  query: 'q1',
  number_of_results: 1
}

// A step with no per-step overrides, typed as researcher.ts's are.
const none = (): FlowStepOverrides => ({})

const searchStep = (...outputs: unknown[]): SearchCapStep => ({
  toolResults: outputs.map(output => ({ toolName: 'search', output }))
})

// The evidence turn (prod chat cznh8gc1gz41vq2lwjb560br, balanced, cap 3):
// step 0 one real search, step 1 four parallel real searches, then a step
// whose search came back capped.
const CAPPED_TURN: SearchCapStep[] = [
  searchStep(realOutput),
  searchStep(realOutput, realOutput, realOutput, realOutput),
  searchStep(capOutput)
]

describe('searchCapReached', () => {
  it('is true once any earlier search came back with the round-cap refusal', () => {
    expect(searchCapReached(CAPPED_TURN)).toBe(true)
    // Mixed into a parallel step with real results, too.
    expect(
      searchCapReached([searchStep(realOutput, capOutput, realOutput)])
    ).toBe(true)
  })

  it('is false for a dedup skip: a skip is not the cap', () => {
    expect(
      searchCapReached([
        searchStep(realOutput),
        searchStep(dedupSkipOutput, duplicateQueryOutput, urlGuidanceOutput)
      ])
    ).toBe(false)
  })

  it('is false with no search results at all', () => {
    expect(searchCapReached([])).toBe(false)
    expect(searchCapReached([{}, { toolResults: [] }])).toBe(false)
    expect(
      searchCapReached([
        { toolResults: [{ toolName: 'fetch', output: realOutput }] }
      ])
    ).toBe(false)
  })

  it('reads only `search` results, and only a literal true flag', () => {
    expect(
      searchCapReached([
        { toolResults: [{ toolName: 'fetch', output: capOutput }] }
      ])
    ).toBe(false)
    expect(
      searchCapReached([
        searchStep({ ...capOutput, searchLimitReached: 'true' }),
        searchStep({ ...capOutput, searchLimitReached: false }),
        searchStep(null, undefined, 'searchLimitReached')
      ])
    ).toBe(false)
  })

  it('does not treat the answer-deadline refusal as the cap', () => {
    // The deadline withdraws every tool itself (applyAnswerDeadline).
    expect(
      searchCapReached([
        searchStep({
          state: 'complete',
          results: [],
          images: [],
          query: 'q',
          number_of_results: 0,
          answerNow: true,
          notice: 'Research time for this turn is over, …'
        })
      ])
    ).toBe(false)
  })
})

describe('withdrawSearchAfterCap', () => {
  it('stops advertising search once the cap has fired, keeping every other tool', () => {
    const out = withdrawSearchAfterCap(none(), {
      steps: CAPPED_TURN,
      defaultActiveTools: MODE_TOOLS
    })
    expect(out.activeTools).toEqual([
      'fetch',
      'todoWrite',
      'calculate',
      'get_weather',
      'remember',
      'recall'
    ])
  })

  it('leaves the step untouched (same object) before the cap fires', () => {
    for (const steps of [
      [],
      [searchStep(realOutput)],
      [searchStep(realOutput), searchStep(dedupSkipOutput)],
      [searchStep(duplicateQueryOutput, urlGuidanceOutput)]
    ]) {
      const overrides = none()
      expect(
        withdrawSearchAfterCap(overrides, {
          steps,
          defaultActiveTools: MODE_TOOLS
        })
      ).toBe(overrides)
    }
  })

  it("filters a flow variant's own activeTools rather than the mode list", () => {
    const out = withdrawSearchAfterCap(
      { activeTools: ['search', 'fetch'], system: 'variant prompt' },
      { steps: CAPPED_TURN, defaultActiveTools: MODE_TOOLS }
    )
    expect(out.activeTools).toEqual(['fetch'])
    // Everything else the variant set is carried through.
    expect(out.system).toBe('variant prompt')
  })

  it('composes with the real flow variants', () => {
    const v = (id: string, stepNumber: number, skipSearch = false) =>
      FLOW_VARIANTS[id].prepareStep?.({
        stepNumber,
        steps: [],
        skipSearch
      }) ?? none()
    const withdraw = (o: FlowStepOverrides) =>
      withdrawSearchAfterCap(o, {
        steps: CAPPED_TURN,
        defaultActiveTools: MODE_TOOLS
      }).activeTools

    // baseline / adaptive / react-gap / plan-execute set no activeTools on a
    // later step: the mode's list, minus search.
    for (const id of ['baseline', 'adaptive', 'react-gap', 'plan-execute']) {
      expect(withdraw(v(id, 3))).toEqual(MODE_TOOLS.filter(t => t !== 'search'))
    }
    // wide-once empties the tool set from step 1: still empty.
    expect(withdraw(v('wide-once', 3))).toEqual([])
    // router on a skip turn: its own search-free list, unchanged.
    expect(withdraw(v('router', 3, true))).toEqual([
      'calculate',
      'get_weather',
      'remember',
      'recall'
    ])
  })

  it('an emptied tool set stays empty', () => {
    expect(
      withdrawSearchAfterCap(
        { activeTools: [] },
        { steps: CAPPED_TURN, defaultActiveTools: MODE_TOOLS }
      ).activeTools
    ).toEqual([])
  })

  it("the answer deadline's empty tool set still wins (applied after)", () => {
    const withdrawn = withdrawSearchAfterCap(none(), {
      steps: CAPPED_TURN,
      defaultActiveTools: MODE_TOOLS
    })
    const o = applyAnswerDeadline(withdrawn, {
      elapsedMs: ANSWER_DEADLINE_MS,
      systemPrompt: 'SYS'
    })
    expect(o.activeTools).toEqual([])
    expect(o.system).toContain('TIME TO ANSWER')
    // Before the deadline the withdrawal passes through untouched.
    expect(
      applyAnswerDeadline(withdrawn, { elapsedMs: 0, systemPrompt: 'SYS' })
    ).toBe(withdrawn)
  })

  it('is idempotent across later steps and never mutates its inputs', () => {
    const modeTools = [...MODE_TOOLS]
    const variantTools = ['search', 'fetch']
    const once = withdrawSearchAfterCap(none(), {
      steps: CAPPED_TURN,
      defaultActiveTools: modeTools
    })
    expect(
      withdrawSearchAfterCap(once, {
        steps: CAPPED_TURN,
        defaultActiveTools: modeTools
      })
    ).toEqual(once)
    // Every later step of the turn (more steps behind it, the model still
    // calling search and still being refused, or doing something else) stays
    // withdrawn — the cap result is still in `steps`.
    const later = [
      ...CAPPED_TURN,
      searchStep(capOutput, capOutput),
      { toolResults: [{ toolName: 'fetch', output: realOutput }] },
      {}
    ]
    for (let i = CAPPED_TURN.length; i <= later.length; i++) {
      expect(
        withdrawSearchAfterCap(none(), {
          steps: later.slice(0, i),
          defaultActiveTools: modeTools
        }).activeTools
      ).toEqual(once.activeTools)
    }
    withdrawSearchAfterCap(
      { activeTools: variantTools },
      { steps: CAPPED_TURN, defaultActiveTools: modeTools }
    )
    expect(modeTools).toEqual([...MODE_TOOLS])
    expect(variantTools).toEqual(['search', 'fetch'])
  })
})

// ── Stage 2: the model keeps calling search after it was withdrawn ──────────

// A step as the AI SDK v6 records it: every call is a `toolCalls` entry. A
// call that ran (or was refused by a tool) also has a `toolResults` entry. A
// call whose input failed the tool's schema ("Invalid input for tool search")
// is a `toolCalls` entry with `invalid: true` plus a `tool-error` content part,
// and has no tool result.
type Call = { toolName: string; output?: unknown; invalid?: boolean }
const sdkStep = (...calls: Call[]): SearchCapStep => ({
  toolCalls: calls.map(c => ({
    toolName: c.toolName,
    ...(c.invalid && { invalid: true })
  })),
  toolResults: calls
    .filter(c => !c.invalid)
    .map(c => ({ toolName: c.toolName, output: c.output }))
})
const refusedSearch: Call = { toolName: 'search', output: capOutput }
const invalidSearch: Call = { toolName: 'search', invalid: true }
const fetchCall: Call = { toolName: 'fetch', output: realOutput }
const answerStep: SearchCapStep = { toolCalls: [], toolResults: [] }

const SYS = 'BASE PROMPT WITH CITATION RULES'

describe('searchCalledAfterWithdrawal', () => {
  it('is true for a refused search call on a step after the withdrawal', () => {
    // Lab chat jcckydan2uqv7l4qelyjq1ob (mistral-large-4, balanced): search
    // withdrawn at step 3, which still made 5 refused search calls.
    expect(
      searchCalledAfterWithdrawal([
        ...CAPPED_TURN,
        sdkStep(
          refusedSearch,
          refusedSearch,
          refusedSearch,
          refusedSearch,
          refusedSearch
        )
      ])
    ).toBe(true)
  })

  it('is true for an invalid-input search call (a tool it no longer sees)', () => {
    // Lab step 4: 3 search calls with invented args, rejected by the schema.
    expect(
      searchCalledAfterWithdrawal([
        ...CAPPED_TURN,
        sdkStep(invalidSearch, invalidSearch, invalidSearch)
      ])
    ).toBe(true)
  })

  it('is true for any other search call after the withdrawal', () => {
    for (const output of [
      dedupSkipOutput,
      duplicateQueryOutput,
      urlGuidanceOutput
    ]) {
      expect(
        searchCalledAfterWithdrawal([
          ...CAPPED_TURN,
          sdkStep({ toolName: 'search', output })
        ])
      ).toBe(true)
    }
  })

  it('is false while the model complies', () => {
    expect(searchCalledAfterWithdrawal([])).toBe(false)
    expect(searchCalledAfterWithdrawal(CAPPED_TURN)).toBe(false)
    expect(searchCalledAfterWithdrawal([...CAPPED_TURN, answerStep])).toBe(
      false
    )
  })

  it('is false for fetch-only steps after the withdrawal', () => {
    // Quality's cap notice deliberately allows fetching found URLs.
    expect(
      searchCalledAfterWithdrawal([
        ...CAPPED_TURN,
        sdkStep(fetchCall, fetchCall),
        sdkStep(fetchCall)
      ])
    ).toBe(false)
  })

  it('ignores search calls made while search was still offered', () => {
    // The capped step's own parallel calls came before the withdrawal.
    expect(
      searchCalledAfterWithdrawal([
        sdkStep({ toolName: 'search', output: realOutput }),
        sdkStep(
          { toolName: 'search', output: realOutput },
          refusedSearch,
          refusedSearch,
          invalidSearch
        )
      ])
    ).toBe(false)
    // No cap at all: searching is just searching.
    expect(
      searchCalledAfterWithdrawal([
        sdkStep({ toolName: 'search', output: realOutput }),
        sdkStep(invalidSearch),
        sdkStep({ toolName: 'search', output: dedupSkipOutput })
      ])
    ).toBe(false)
  })
})

describe('answerNowOnSearchEvasion', () => {
  const EVADED = [...CAPPED_TURN, sdkStep(refusedSearch)]

  it("switches the step to answer-now with the deadline's own override", () => {
    const out = answerNowOnSearchEvasion(none(), {
      steps: EVADED,
      systemPrompt: SYS
    })
    expect(out).toEqual(answerNowOverrides(none(), SYS))
    expect(out.activeTools).toEqual([])
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
  })

  it("keeps a variant's replacement prompt and empties its tool list", () => {
    const out = answerNowOnSearchEvasion(
      { activeTools: ['fetch'], system: 'variant prompt' },
      { steps: EVADED, systemPrompt: SYS }
    )
    expect(out.activeTools).toEqual([])
    expect(out.system).toBe(`variant prompt${ANSWER_NOW_NOTE}`)
  })

  it('leaves the step untouched (same object) for a compliant model', () => {
    for (const steps of [
      [],
      CAPPED_TURN,
      [...CAPPED_TURN, sdkStep(fetchCall)],
      [...CAPPED_TURN, answerStep]
    ]) {
      const overrides = withdrawSearchAfterCap(none(), {
        steps,
        defaultActiveTools: MODE_TOOLS
      })
      expect(
        answerNowOnSearchEvasion(overrides, { steps, systemPrompt: SYS })
      ).toBe(overrides)
    }
  })

  it('stays on for every later step of the turn', () => {
    const later = [
      ...EVADED,
      sdkStep({ toolName: 'search', output: { answerNow: true } }),
      answerStep
    ]
    for (let i = EVADED.length; i <= later.length; i++) {
      expect(
        answerNowOnSearchEvasion(none(), {
          steps: later.slice(0, i),
          systemPrompt: SYS
        })
      ).toEqual(answerNowOverrides(none(), SYS))
    }
  })

  it('the time deadline still applies on top, without a second note', () => {
    // researcher.ts order: variant -> withdraw search -> answer-now on
    // evasion -> time deadline.
    const stage1 = withdrawSearchAfterCap(none(), {
      steps: EVADED,
      defaultActiveTools: MODE_TOOLS
    })
    const stage2 = answerNowOnSearchEvasion(stage1, {
      steps: EVADED,
      systemPrompt: SYS
    })
    const past = applyAnswerDeadline(stage2, {
      elapsedMs: ANSWER_DEADLINE_MS,
      systemPrompt: SYS
    })
    expect(past.activeTools).toEqual([])
    expect(past.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
    // A new object only when the TIME deadline fired, so researcher.ts's
    // identity check (deadline log, citation reminder) still means time.
    expect(past).not.toBe(stage2)
    expect(
      applyAnswerDeadline(stage2, { elapsedMs: 0, systemPrompt: SYS })
    ).toBe(stage2)
  })
})

// ── Stage 3: tool steps after the cap, in modes whose notice says answer now ──

describe('resolvePostCapToolStepsLimit', () => {
  it('is POST_CAP_TOOL_STEPS_MAX (default 4) in modes without a fetch budget', () => {
    expect(POST_CAP_TOOL_STEPS_MAX_DEFAULT).toBe(4)
    for (const mode of ['balanced', 'speed', undefined] as const) {
      expect(resolvePostCapToolStepsLimit(mode, {})).toBe(4)
    }
  })

  it('is null (no limit) where the cap notice still offers fetch', () => {
    // Quality has a finite fetch budget (fetch-budget.ts), and its cap notice
    // deliberately allows fetching found URLs after the cap.
    expect(resolvePostCapToolStepsLimit('quality', {})).toBeNull()
    // So does any mode once FETCH_ROUNDS_MAX gives it a fetch budget.
    expect(
      resolvePostCapToolStepsLimit('balanced', { FETCH_ROUNDS_MAX: '6' })
    ).toBeNull()
  })

  it('honours a valid POST_CAP_TOOL_STEPS_MAX and ignores an invalid one', () => {
    expect(
      resolvePostCapToolStepsLimit('balanced', { POST_CAP_TOOL_STEPS_MAX: '6' })
    ).toBe(6)
    expect(
      resolvePostCapToolStepsLimit('balanced', {
        POST_CAP_TOOL_STEPS_MAX: '2.7'
      })
    ).toBe(2)
    for (const raw of ['', ' ', 'abc', '0', '-3', 'Infinity']) {
      expect(
        resolvePostCapToolStepsLimit('balanced', {
          POST_CAP_TOOL_STEPS_MAX: raw
        })
      ).toBe(4)
    }
    // The override never turns the limit on in quality.
    expect(
      resolvePostCapToolStepsLimit('quality', { POST_CAP_TOOL_STEPS_MAX: '2' })
    ).toBeNull()
  })
})

// Lab chat jcckydan2uqv7l4qelyjq1ob, follow-up turn (mistral-large-4,
// balanced): cap at step 2, search withdrawn at step 3, then one fetch per
// step on steps 3-15, answer at step 16.
const fetchSteps = (n: number) =>
  Array.from({ length: n }, () => sdkStep(fetchCall))

describe('toolStepsAfterCap', () => {
  it('counts the steps after the capped one that made any tool call', () => {
    expect(toolStepsAfterCap(CAPPED_TURN)).toBe(0)
    expect(toolStepsAfterCap([...CAPPED_TURN, ...fetchSteps(3)])).toBe(3)
    expect(
      toolStepsAfterCap([
        ...CAPPED_TURN,
        sdkStep(fetchCall, fetchCall),
        sdkStep(invalidSearch),
        sdkStep({ toolName: 'calculate', output: { result: 2 } }),
        answerStep
      ])
    ).toBe(3)
  })

  it('is 0 before the cap, whatever the turn did', () => {
    expect(toolStepsAfterCap([])).toBe(0)
    expect(
      toolStepsAfterCap([
        sdkStep({ toolName: 'search', output: realOutput }),
        ...fetchSteps(8)
      ])
    ).toBe(0)
  })
})

describe('answerNowAfterPostCapToolSteps', () => {
  const opts = (steps: SearchCapStep[], maxToolSteps: number | null) => ({
    steps,
    systemPrompt: SYS,
    maxToolSteps
  })

  it('balanced: 4 tool steps after the cap stay offered, the 5th step is answer-now', () => {
    // prepareStep for the k-th step after the capped one sees k-1 tool steps.
    for (let done = 0; done < 4; done++) {
      const overrides = none()
      expect(
        answerNowAfterPostCapToolSteps(
          overrides,
          opts([...CAPPED_TURN, ...fetchSteps(done)], 4)
        )
      ).toBe(overrides)
    }
    for (const done of [4, 5, 13]) {
      expect(
        answerNowAfterPostCapToolSteps(
          none(),
          opts([...CAPPED_TURN, ...fetchSteps(done)], 4)
        )
      ).toEqual(answerNowOverrides(none(), SYS))
    }
  })

  it('quality (no limit): unchanged however many tool steps follow the cap', () => {
    for (const done of [0, 4, 8, 30]) {
      const overrides = none()
      expect(
        answerNowAfterPostCapToolSteps(
          overrides,
          opts([...CAPPED_TURN, ...fetchSteps(done)], null)
        )
      ).toBe(overrides)
    }
  })

  it('never fires before the cap', () => {
    const overrides = none()
    expect(
      answerNowAfterPostCapToolSteps(
        overrides,
        opts(
          [
            sdkStep({ toolName: 'search', output: realOutput }),
            ...fetchSteps(9)
          ],
          4
        )
      )
    ).toBe(overrides)
  })

  it("keeps a variant's replacement prompt", () => {
    expect(
      answerNowAfterPostCapToolSteps(
        { system: 'variant prompt' },
        opts([...CAPPED_TURN, ...fetchSteps(4)], 4)
      ).system
    ).toBe(`variant prompt${ANSWER_NOW_NOTE}`)
  })

  // researcher.ts order: variant -> withdraw search -> answer-now on search
  // after withdrawal -> answer-now after N post-cap tool steps -> deadline.
  const pipeline = (
    steps: SearchCapStep[],
    maxToolSteps: number | null,
    elapsedMs = 0
  ) => {
    const stage1 = withdrawSearchAfterCap(none(), {
      steps,
      defaultActiveTools: MODE_TOOLS
    })
    const stage2 = answerNowOnSearchEvasion(stage1, {
      steps,
      systemPrompt: SYS
    })
    const stage3 = answerNowAfterPostCapToolSteps(
      stage2,
      opts(steps, maxToolSteps)
    )
    const out = applyAnswerDeadline(stage3, { elapsedMs, systemPrompt: SYS })
    return { stage1, stage2, stage3, out }
  }

  it('the lab turn switches at step 7 instead of answering at step 16', () => {
    const turn = [...CAPPED_TURN, ...fetchSteps(13)]
    // steps.slice(0, i) is what prepareStep sees for step i.
    const switchedAt = Array.from(
      { length: turn.length + 1 },
      (_, i) => i
    ).find(i => pipeline(turn.slice(0, i), 4).out.activeTools?.length === 0)
    expect(switchedAt).toBe(7)
    // Steps 3-6 offer everything except search.
    for (let i = 3; i < 7; i++) {
      expect(pipeline(turn.slice(0, i), 4).out.activeTools).toEqual(
        MODE_TOOLS.filter(t => t !== 'search')
      )
    }
  })

  it('stage 2 still fires first, on the step after a search call', () => {
    const steps = [...CAPPED_TURN, sdkStep(refusedSearch)]
    const { stage2, stage3, out } = pipeline(steps, 4)
    expect(stage2.activeTools).toEqual([])
    // Stage 3 has nothing to add (1 tool step < 4) and passes it through.
    expect(stage3).toBe(stage2)
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
  })

  it('both answer-now stages and the deadline together: no tools, one note', () => {
    const steps = [
      ...CAPPED_TURN,
      ...fetchSteps(3),
      sdkStep(refusedSearch),
      sdkStep(fetchCall)
    ]
    const { stage3, out } = pipeline(steps, 4, ANSWER_DEADLINE_MS)
    expect(out.activeTools).toEqual([])
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
    // The deadline still returns a new object: researcher.ts's identity check
    // keeps meaning the TIME deadline.
    expect(out).not.toBe(stage3)
    const before = pipeline(steps, 4, 0)
    expect(before.out).toBe(before.stage3)
  })
})
