import { describe, expect, it } from 'vitest'

import {
  buildSearchRoundCapNotice,
  buildSearchWithdrawnNote
} from '../../tools/search-rounds'
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
  resolveSearchWithdrawnNote,
  searchBudgetSpent,
  searchCalledAfterWithdrawal,
  searchCapReached,
  type SearchCapStep,
  toolStepsAfterWithdrawal,
  withdrawSearchAfterCap,
  withSearchWithdrawnNote
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
const WITHOUT_SEARCH = MODE_TOOLS.filter(t => t !== 'search')

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

// The latest prod turn (chat cznh8gc1gz41vq2lwjb560br, mistral-large-4,
// balanced, budget 3): step 0 one real search, step 1 four parallel real
// searches (5 rounds used: the known check-then-act overshoot). The budget is
// spent after step 1, so step 2 is the withdrawal step.
const BUDGET_SPENT_TURN: SearchCapStep[] = [
  searchStep(realOutput),
  searchStep(realOutput, realOutput, realOutput, realOutput)
]
const W = BUDGET_SPENT_TURN.length

describe('searchCapReached', () => {
  it('is true once any earlier search came back with the round-cap refusal', () => {
    expect(
      searchCapReached([...BUDGET_SPENT_TURN, searchStep(capOutput)])
    ).toBe(true)
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

describe('searchBudgetSpent', () => {
  it("is true as soon as the search tool's own counter reaches the budget — before any search is refused", () => {
    // The proactive trigger: nothing in the steps says "cap" yet.
    expect(searchCapReached(BUDGET_SPENT_TURN)).toBe(false)
    expect(
      searchBudgetSpent(BUDGET_SPENT_TURN, { roundsUsed: 5, roundsBudget: 3 })
    ).toBe(true)
    expect(
      searchBudgetSpent([searchStep(realOutput, realOutput, realOutput)], {
        roundsUsed: 3,
        roundsBudget: 3
      })
    ).toBe(true)
  })

  it('is false while rounds remain, however many search calls the steps hold', () => {
    // Skips and short-circuits are calls, not rounds: only the counter says.
    expect(
      searchBudgetSpent(
        [
          searchStep(realOutput, realOutput),
          searchStep(dedupSkipOutput, duplicateQueryOutput, urlGuidanceOutput)
        ],
        { roundsUsed: 2, roundsBudget: 3 }
      )
    ).toBe(false)
    expect(searchBudgetSpent([], { roundsUsed: 0, roundsBudget: 3 })).toBe(
      false
    )
  })

  it('falls back to a refused result when the counter says otherwise', () => {
    // A search tool that does not share its counter: the refusal still
    // withdraws search, as before the counter existed.
    expect(
      searchBudgetSpent([searchStep(realOutput), searchStep(capOutput)], {
        roundsUsed: 0,
        roundsBudget: 3
      })
    ).toBe(true)
  })
})

describe('withdrawSearchAfterCap', () => {
  const opts = (withdrawnAtStep: number | null) => ({
    withdrawnAtStep,
    defaultActiveTools: MODE_TOOLS
  })

  it('stops advertising search once withdrawn, keeping every other tool', () => {
    expect(withdrawSearchAfterCap(none(), opts(W)).activeTools).toEqual(
      WITHOUT_SEARCH
    )
  })

  it('leaves the step untouched (same object) until search is withdrawn', () => {
    const overrides = none()
    expect(withdrawSearchAfterCap(overrides, opts(null))).toBe(overrides)
  })

  it("filters a flow variant's own activeTools rather than the mode list", () => {
    const out = withdrawSearchAfterCap(
      { activeTools: ['search', 'fetch'], system: 'variant prompt' },
      opts(W)
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
      withdrawSearchAfterCap(o, opts(W)).activeTools

    // baseline / adaptive / react-gap / plan-execute set no activeTools on a
    // later step: the mode's list, minus search.
    for (const id of ['baseline', 'adaptive', 'react-gap', 'plan-execute']) {
      expect(withdraw(v(id, 3))).toEqual(WITHOUT_SEARCH)
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

  it('returns the step itself when its list has no search to remove', () => {
    // Identity then means "search disappeared on this step", which is what
    // withSearchWithdrawnNote keys on (stable-knowledge turns, a variant's
    // emptied or search-free list).
    for (const overrides of [
      { activeTools: [] },
      { activeTools: ['calculate', 'recall'] }
    ]) {
      expect(withdrawSearchAfterCap(overrides, opts(W))).toBe(overrides)
    }
    const noSearchMode = none()
    expect(
      withdrawSearchAfterCap(noSearchMode, {
        withdrawnAtStep: W,
        defaultActiveTools: ['calculate', 'get_weather', 'remember', 'recall']
      })
    ).toBe(noSearchMode)
  })

  it("the answer deadline's empty tool set still wins (applied after)", () => {
    const withdrawn = withdrawSearchAfterCap(none(), opts(W))
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

  it('never mutates its inputs', () => {
    const modeTools = [...MODE_TOOLS]
    const variantTools = ['search', 'fetch']
    withdrawSearchAfterCap(none(), {
      withdrawnAtStep: W,
      defaultActiveTools: modeTools
    })
    withdrawSearchAfterCap(
      { activeTools: variantTools },
      { withdrawnAtStep: W, defaultActiveTools: modeTools }
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
const realSearch: Call = { toolName: 'search', output: realOutput }
const refusedSearch: Call = { toolName: 'search', output: capOutput }
const invalidSearch: Call = { toolName: 'search', invalid: true }
const fetchCall: Call = { toolName: 'fetch', output: realOutput }
const answerStep: SearchCapStep = { toolCalls: [], toolResults: [] }

// BUDGET_SPENT_TURN with the calls recorded too.
const SPENT: SearchCapStep[] = [
  sdkStep(realSearch),
  sdkStep(realSearch, realSearch, realSearch, realSearch)
]

const SYS = 'BASE PROMPT WITH CITATION RULES'
const NOTE = buildSearchWithdrawnNote(3, false)

describe('searchCalledAfterWithdrawal', () => {
  it('is true for a refused search call on the withdrawal step or later', () => {
    // The prod turn: step 3 ran without search and still made 4 calls, all
    // refused by the tool's cap.
    const refused4 = sdkStep(
      refusedSearch,
      refusedSearch,
      refusedSearch,
      refusedSearch
    )
    expect(searchCalledAfterWithdrawal([...SPENT, refused4], W)).toBe(true)
    expect(
      searchCalledAfterWithdrawal([...SPENT, answerStep, refused4], W)
    ).toBe(true)
  })

  it('is true for an invalid-input search call (a tool it no longer sees)', () => {
    // Lab chat jcckydan2uqv7l4qelyjq1ob: 3 search calls with invented args.
    expect(
      searchCalledAfterWithdrawal(
        [...SPENT, sdkStep(invalidSearch, invalidSearch, invalidSearch)],
        W
      )
    ).toBe(true)
  })

  it('is true for any other search call after the withdrawal', () => {
    for (const output of [
      realOutput,
      dedupSkipOutput,
      duplicateQueryOutput,
      urlGuidanceOutput
    ]) {
      expect(
        searchCalledAfterWithdrawal(
          [...SPENT, sdkStep({ toolName: 'search', output })],
          W
        )
      ).toBe(true)
    }
  })

  it('is false while the model complies', () => {
    expect(searchCalledAfterWithdrawal(SPENT, W)).toBe(false)
    expect(searchCalledAfterWithdrawal([...SPENT, answerStep], W)).toBe(false)
    // Quality's notes deliberately allow fetching found URLs.
    expect(
      searchCalledAfterWithdrawal(
        [...SPENT, sdkStep(fetchCall, fetchCall), sdkStep(fetchCall)],
        W
      )
    ).toBe(false)
  })

  it('ignores search calls made while search was still offered', () => {
    // Refused and invalid calls on a step that still offered search (the
    // budget ran out mid-step) are not evasion.
    const turn = [
      sdkStep(realSearch),
      sdkStep(realSearch, refusedSearch, refusedSearch, invalidSearch)
    ]
    expect(searchCalledAfterWithdrawal(turn, 2)).toBe(false)
    // Nothing withdrawn: searching is just searching.
    expect(
      searchCalledAfterWithdrawal(
        [sdkStep(realSearch), sdkStep(invalidSearch), sdkStep(refusedSearch)],
        null
      )
    ).toBe(false)
  })

  it('counts from the step search was actually withdrawn at', () => {
    // The fallback path (a refusal, not the counter): search withdrawn at
    // step 3, the step AFTER the refusals; step 2's calls were offered ones.
    const turn = [
      sdkStep(realSearch),
      sdkStep(realSearch, realSearch),
      sdkStep(refusedSearch, refusedSearch),
      sdkStep(fetchCall)
    ]
    expect(searchCalledAfterWithdrawal(turn, 3)).toBe(false)
    expect(searchCalledAfterWithdrawal(turn, 2)).toBe(true)
  })
})

describe('answerNowOnSearchEvasion', () => {
  const EVADED = [...SPENT, sdkStep(refusedSearch)]
  const opts = (steps: SearchCapStep[], withdrawnAtStep: number | null) => ({
    steps,
    withdrawnAtStep,
    systemPrompt: SYS
  })

  it("switches the step to answer-now with the deadline's own override", () => {
    const out = answerNowOnSearchEvasion(none(), opts(EVADED, W))
    expect(out).toEqual(answerNowOverrides(none(), SYS))
    expect(out.activeTools).toEqual([])
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
  })

  it("keeps a variant's replacement prompt and empties its tool list", () => {
    const out = answerNowOnSearchEvasion(
      { activeTools: ['fetch'], system: 'variant prompt' },
      opts(EVADED, W)
    )
    expect(out.activeTools).toEqual([])
    expect(out.system).toBe(`variant prompt${ANSWER_NOW_NOTE}`)
  })

  it('leaves the step untouched (same object) for a compliant model', () => {
    for (const steps of [
      [],
      SPENT,
      [...SPENT, sdkStep(fetchCall)],
      [...SPENT, answerStep]
    ]) {
      const overrides = withdrawSearchAfterCap(none(), {
        withdrawnAtStep: steps.length >= W ? W : null,
        defaultActiveTools: MODE_TOOLS
      })
      expect(
        answerNowOnSearchEvasion(
          overrides,
          opts(steps, steps.length >= W ? W : null)
        )
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
        answerNowOnSearchEvasion(none(), opts(later.slice(0, i), W))
      ).toEqual(answerNowOverrides(none(), SYS))
    }
  })
})

// ── Stage 3: tool steps after the withdrawal, where the notice says answer now ──

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

const fetchSteps = (n: number) =>
  Array.from({ length: n }, () => sdkStep(fetchCall))

describe('toolStepsAfterWithdrawal', () => {
  it('counts the steps from the withdrawal step on that made any tool call', () => {
    expect(toolStepsAfterWithdrawal(SPENT, W)).toBe(0)
    expect(toolStepsAfterWithdrawal([...SPENT, ...fetchSteps(3)], W)).toBe(3)
    expect(
      toolStepsAfterWithdrawal(
        [
          ...SPENT,
          sdkStep(fetchCall, fetchCall),
          sdkStep(invalidSearch),
          sdkStep({ toolName: 'calculate', output: { result: 2 } }),
          answerStep
        ],
        W
      )
    ).toBe(3)
  })

  it('is 0 until search is withdrawn, whatever the turn did', () => {
    expect(toolStepsAfterWithdrawal([], null)).toBe(0)
    expect(
      toolStepsAfterWithdrawal([sdkStep(realSearch), ...fetchSteps(8)], null)
    ).toBe(0)
  })
})

describe('answerNowAfterPostCapToolSteps', () => {
  const opts = (
    steps: SearchCapStep[],
    maxToolSteps: number | null,
    withdrawnAtStep: number | null = W
  ) => ({
    steps,
    withdrawnAtStep,
    systemPrompt: SYS,
    maxToolSteps
  })

  it('balanced: 4 tool steps without search stay offered, the 5th step is answer-now', () => {
    // prepareStep for the k-th step from the withdrawal sees k-1 tool steps.
    for (let done = 0; done < 4; done++) {
      const overrides = none()
      expect(
        answerNowAfterPostCapToolSteps(
          overrides,
          opts([...SPENT, ...fetchSteps(done)], 4)
        )
      ).toBe(overrides)
    }
    for (const done of [4, 5, 13]) {
      expect(
        answerNowAfterPostCapToolSteps(
          none(),
          opts([...SPENT, ...fetchSteps(done)], 4)
        )
      ).toEqual(answerNowOverrides(none(), SYS))
    }
  })

  it('quality (no limit): unchanged however many tool steps follow', () => {
    for (const done of [0, 4, 8, 30]) {
      const overrides = none()
      expect(
        answerNowAfterPostCapToolSteps(
          overrides,
          opts([...SPENT, ...fetchSteps(done)], null)
        )
      ).toBe(overrides)
    }
  })

  it('never fires before the withdrawal', () => {
    const overrides = none()
    expect(
      answerNowAfterPostCapToolSteps(
        overrides,
        opts([sdkStep(realSearch), ...fetchSteps(9)], 4, null)
      )
    ).toBe(overrides)
  })

  it("keeps a variant's replacement prompt", () => {
    expect(
      answerNowAfterPostCapToolSteps(
        { system: 'variant prompt' },
        opts([...SPENT, ...fetchSteps(4)], 4)
      ).system
    ).toBe(`variant prompt${ANSWER_NOW_NOTE}`)
  })
})

// ── Stage 1's note: why `search` disappeared ─────────────────────────────────

describe('resolveSearchWithdrawnNote', () => {
  it("words the note like the mode's cap notice: answer now, or fetch allowed", () => {
    expect(resolveSearchWithdrawnNote('balanced', {})).toBe(
      buildSearchWithdrawnNote(3, false)
    )
    expect(
      resolveSearchWithdrawnNote('speed', { SEARCH_ROUNDS_MAX: '2' })
    ).toBe(buildSearchWithdrawnNote(2, false))
    expect(resolveSearchWithdrawnNote('quality', {})).toBe(
      buildSearchWithdrawnNote(10, true)
    )
    expect(
      resolveSearchWithdrawnNote('balanced', { FETCH_ROUNDS_MAX: '6' })
    ).toBe(buildSearchWithdrawnNote(3, true))
  })
})

describe('withSearchWithdrawnNote', () => {
  const withdraw = (offered: FlowStepOverrides) =>
    withdrawSearchAfterCap(offered, {
      withdrawnAtStep: W,
      defaultActiveTools: MODE_TOOLS
    })
  const note = (
    step: FlowStepOverrides,
    offered: FlowStepOverrides,
    withdrawn: FlowStepOverrides
  ) =>
    withSearchWithdrawnNote(step, {
      offered,
      withdrawn,
      systemPrompt: SYS,
      note: NOTE
    })

  it('appends the note to the prompt in force on a step that lost search', () => {
    const offered = none()
    const withdrawn = withdraw(offered)
    const out = note(withdrawn, offered, withdrawn)
    expect(out.system).toBe(`${SYS}\n\n${NOTE}`)
    expect(out.activeTools).toEqual(WITHOUT_SEARCH)
    // A variant's replacement prompt keeps its replacement.
    const variant = { system: 'variant prompt' }
    const vWithdrawn = withdraw(variant)
    expect(note(vWithdrawn, variant, vWithdrawn).system).toBe(
      `variant prompt\n\n${NOTE}`
    )
  })

  it('adds it once', () => {
    const offered = { system: `${SYS}\n\n${NOTE}` }
    const withdrawn = withdraw(offered)
    expect(note(withdrawn, offered, withdrawn).system).toBe(`${SYS}\n\n${NOTE}`)
  })

  it('not before the withdrawal, and not where search was never offered', () => {
    const offered = none()
    expect(note(offered, offered, offered)).toBe(offered)
    const searchFree = { activeTools: ['calculate', 'recall'] }
    const same = withdraw(searchFree)
    expect(note(same, searchFree, same)).toBe(searchFree)
  })

  it('not on an answer-now step: ANSWER_NOW_NOTE speaks there, alone', () => {
    // Stage 2/3 or the time deadline replaced the withdrawn step. Quality's
    // note ("you may still fetch") would contradict "no tools".
    const offered = none()
    const withdrawn = withdraw(offered)
    const answerNow = answerNowOverrides(withdrawn, SYS)
    const out = note(answerNow, offered, withdrawn)
    expect(out).toBe(answerNow)
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
  })
})

// ── The whole prepareStep pipeline, replayed step by step ───────────────────

// researcher.ts: record the withdrawal step the first time the budget is spent,
// then variant -> withdraw search -> answer-now on a search call after the
// withdrawal -> answer-now after N tool steps -> time deadline -> the note.
function replay(
  turn: SearchCapStep[],
  {
    roundsAfterStep,
    roundsBudget = 3,
    maxToolSteps = 4 as number | null,
    elapsedMs = 0
  }: {
    /** The search tool's counter after each step of `turn`. */
    roundsAfterStep: number[]
    roundsBudget?: number
    maxToolSteps?: number | null
    elapsedMs?: number
  }
) {
  let withdrawnAtStep: number | null = null
  return Array.from({ length: turn.length + 1 }, (_, stepNumber) => {
    const steps = turn.slice(0, stepNumber)
    const roundsUsed = stepNumber === 0 ? 0 : roundsAfterStep[stepNumber - 1]
    if (
      withdrawnAtStep === null &&
      searchBudgetSpent(steps, { roundsUsed, roundsBudget })
    ) {
      withdrawnAtStep = stepNumber
    }
    const offered = none()
    const stage1 = withdrawSearchAfterCap(offered, {
      withdrawnAtStep,
      defaultActiveTools: MODE_TOOLS
    })
    const stage2 = answerNowOnSearchEvasion(stage1, {
      steps,
      withdrawnAtStep,
      systemPrompt: SYS
    })
    const stage3 = answerNowAfterPostCapToolSteps(stage2, {
      steps,
      withdrawnAtStep,
      systemPrompt: SYS,
      maxToolSteps
    })
    const deadline = applyAnswerDeadline(stage3, {
      elapsedMs,
      systemPrompt: SYS
    })
    const out = withSearchWithdrawnNote(deadline, {
      offered,
      withdrawn: stage1,
      systemPrompt: SYS,
      note: NOTE
    })
    return { withdrawnAtStep, stage1, stage3, deadline, out }
  })
}
const noteCount = (o: FlowStepOverrides) =>
  (o.system ?? '').split(NOTE).length - 1
const answerNow = (o: FlowStepOverrides) =>
  o.activeTools?.length === 0 && (o.system ?? '').endsWith(ANSWER_NOW_NOTE)

describe('prepareStep pipeline', () => {
  it('the prod turn: search is gone at step 2, before any search was refused', () => {
    // Stored: step 2 still offered search and made 4 refused calls, step 3
    // (withdrawn) 4 more, step 4 (answer-now) 4 more, answer at step 5.
    // Replayed with the same model behaviour per offer: step 2 is the
    // withdrawn step (old step 3), its 4 calls refused by the tool's cap.
    const turn = [
      ...SPENT,
      sdkStep(refusedSearch, refusedSearch, refusedSearch, refusedSearch)
    ]
    const steps = replay(turn, { roundsAfterStep: [1, 5, 5] })
    for (const i of [0, 1]) {
      expect(steps[i].out).toEqual({})
    }
    expect(steps[2].withdrawnAtStep).toBe(2)
    expect(steps[2].out.activeTools).toEqual(WITHOUT_SEARCH)
    expect(noteCount(steps[2].out)).toBe(1)
    // It searched anyway: step 3 is answer-now, without the note.
    expect(answerNow(steps[3].out)).toBe(true)
    expect(noteCount(steps[3].out)).toBe(0)
  })

  it('a compliant turn: the step after the budget is spent offers no search', () => {
    const steps = replay(SPENT, { roundsAfterStep: [1, 5] })
    expect(steps[2].out.activeTools).toEqual(WITHOUT_SEARCH)
    expect(steps[2].out.system).toBe(`${SYS}\n\n${NOTE}`)
  })

  it('rounds left: search stays offered, whatever the calls returned', () => {
    // Two real searches and two calls that ran nothing (dedup skip, exact
    // repeat): 2 of 3 rounds used.
    const turn = [
      sdkStep(realSearch, realSearch),
      sdkStep(
        { toolName: 'search', output: dedupSkipOutput },
        { toolName: 'search', output: duplicateQueryOutput }
      )
    ]
    const steps = replay(turn, { roundsAfterStep: [2, 2] })
    for (const s of steps) {
      expect(s.out).toEqual({})
      expect(s.withdrawnAtStep).toBeNull()
    }
  })

  it('the refusal fallback withdraws from the step after it, as before', () => {
    // A counter that never moved (not shared): the refusal at step 2 is the
    // only signal, so search goes at step 3 and stage 2 counts from there.
    const turn = [
      sdkStep(realSearch),
      sdkStep(realSearch, realSearch),
      sdkStep(refusedSearch),
      sdkStep(fetchCall)
    ]
    const steps = replay(turn, { roundsAfterStep: [0, 0, 0, 0] })
    expect(steps[2].out).toEqual({})
    expect(steps[3].withdrawnAtStep).toBe(3)
    expect(steps[3].out.activeTools).toEqual(WITHOUT_SEARCH)
    expect(answerNow(steps[4].out)).toBe(false)
  })

  it('stage 3 counts tool steps from the withdrawal step: 4 fetch steps, then answer-now', () => {
    // Lab chat jcckydan2uqv7l4qelyjq1ob, follow-up turn: one fetch per step
    // after search was withdrawn.
    const turn = [...SPENT, ...fetchSteps(13)]
    const steps = replay(turn, {
      roundsAfterStep: turn.map((_, i) => (i ? 5 : 1))
    })
    for (const i of [2, 3, 4, 5]) {
      expect(steps[i].out.activeTools).toEqual(WITHOUT_SEARCH)
      expect(noteCount(steps[i].out)).toBe(1)
    }
    const switchedAt = steps.findIndex(s => answerNow(s.out))
    expect(switchedAt).toBe(6)
    expect(noteCount(steps[6].out)).toBe(0)
    // Quality: no limit, fetch stays offered with the note.
    const quality = replay(turn, {
      roundsAfterStep: turn.map((_, i) => (i ? 5 : 1)),
      maxToolSteps: null
    })
    expect(quality.some(s => answerNow(s.out))).toBe(false)
  })

  it('the time deadline still applies on top: no tools, one note, identity kept', () => {
    const turn = [...SPENT, ...fetchSteps(2)]
    const steps = replay(turn, {
      roundsAfterStep: [1, 5, 5, 5],
      elapsedMs: ANSWER_DEADLINE_MS
    })
    const last = steps[steps.length - 1]
    expect(last.out.activeTools).toEqual([])
    expect(last.out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
    // A new object only when the TIME deadline fired, so researcher.ts's
    // identity check (deadline log, citation reminder) still means time.
    expect(last.deadline).not.toBe(last.stage3)
    const before = replay(turn, { roundsAfterStep: [1, 5, 5, 5] })
    const b = before[before.length - 1]
    expect(b.deadline).toBe(b.stage3)
  })
})
