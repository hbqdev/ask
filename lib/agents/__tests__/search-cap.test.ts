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
  answerNowOnSearchEvasion,
  searchCalledAfterWithdrawal,
  searchCapReached,
  type SearchCapStep,
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
