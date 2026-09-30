import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CITATION_REMINDER_MIN_TOOL_CALLS_DEFAULT,
  countCitableToolCalls,
  getCitationReminderText,
  isCitationReminderEnabled,
  resolveCitationReminderMinToolCalls,
  resolveCitationReminderMode,
  withCitationReminder
} from '../citation-reminder'

afterEach(() => {
  vi.unstubAllEnvs()
})

const step = (...names: string[]) => ({
  toolCalls: names.map(toolName => ({ toolName }))
})

describe('countCitableToolCalls', () => {
  it('counts search and fetch calls only', () => {
    expect(
      countCitableToolCalls([
        step('search'),
        step('todoWrite'),
        step('search', 'search'),
        step('fetch'),
        step('calculate'),
        {}
      ])
    ).toBe(4)
  })
})

describe('resolveCitationReminderMinToolCalls', () => {
  it('defaults to 8', () => {
    expect(CITATION_REMINDER_MIN_TOOL_CALLS_DEFAULT).toBe(8)
    expect(resolveCitationReminderMinToolCalls({})).toBe(8)
  })

  it('honours a positive override and floors it', () => {
    expect(
      resolveCitationReminderMinToolCalls({
        CITATION_REMINDER_MIN_TOOL_CALLS: '5'
      })
    ).toBe(5)
    expect(
      resolveCitationReminderMinToolCalls({
        CITATION_REMINDER_MIN_TOOL_CALLS: '3.7'
      })
    ).toBe(3)
  })

  it('falls back to the default on invalid values', () => {
    for (const bad of ['0', '-1', 'abc', '', ' ']) {
      expect(
        resolveCitationReminderMinToolCalls({
          CITATION_REMINDER_MIN_TOOL_CALLS: bad
        })
      ).toBe(8)
    }
  })
})

describe('resolveCitationReminderMode', () => {
  it('is none below the threshold and answer-step from it', () => {
    expect(resolveCitationReminderMode({ citableToolCalls: 7, env: {} })).toBe(
      'none'
    )
    expect(resolveCitationReminderMode({ citableToolCalls: 8, env: {} })).toBe(
      'answer-step'
    )
    expect(resolveCitationReminderMode({ citableToolCalls: 18, env: {} })).toBe(
      'answer-step'
    )
  })

  it('appends directly on the answer-deadline step whenever something is citable', () => {
    expect(
      resolveCitationReminderMode({
        citableToolCalls: 1,
        answerDeadlinePassed: true,
        env: {}
      })
    ).toBe('append')
    expect(
      resolveCitationReminderMode({
        citableToolCalls: 20,
        answerDeadlinePassed: true,
        env: {}
      })
    ).toBe('append')
    // Nothing to cite: no reminder, deadline or not.
    expect(
      resolveCitationReminderMode({
        citableToolCalls: 0,
        answerDeadlinePassed: true,
        env: {}
      })
    ).toBe('none')
  })

  it('CITATION_REMINDER=off disables it entirely', () => {
    const env = { CITATION_REMINDER: 'off' }
    expect(resolveCitationReminderMode({ citableToolCalls: 30, env })).toBe(
      'none'
    )
    expect(
      resolveCitationReminderMode({
        citableToolCalls: 3,
        answerDeadlinePassed: true,
        env
      })
    ).toBe('none')
    expect(isCitationReminderEnabled(env)).toBe(false)
    expect(isCitationReminderEnabled({})).toBe(true)
  })

  it('follows CITATION_REMINDER_MIN_TOOL_CALLS', () => {
    const env = { CITATION_REMINDER_MIN_TOOL_CALLS: '12' }
    expect(resolveCitationReminderMode({ citableToolCalls: 11, env })).toBe(
      'none'
    )
    expect(resolveCitationReminderMode({ citableToolCalls: 12, env })).toBe(
      'answer-step'
    )
  })
})

describe('getCitationReminderText', () => {
  it('with CITATION_HANDLES on (default) tells the model to copy the `cite` string and not to number sources', () => {
    const t = getCitationReminderText()
    expect(t).toContain("copy that result's `cite` string exactly")
    expect(t).toContain('no running count across the answer')
    expect(t).toContain('no "Sources:" line or reference list')
    // Not something to answer.
    expect(t).toContain('It is not a new question')
    expect(t).toContain('Do not reply to it or mention it')
  })

  it('with CITATION_HANDLES=off states the within-call numbering instead', () => {
    vi.stubEnv('CITATION_HANDLES', 'off')
    const t = getCitationReminderText()
    expect(t).not.toContain('`cite`')
    expect(t).toContain("N is the result's position in THAT call's `results`")
  })
})

describe('withCitationReminder', () => {
  it('appends the reminder as a trailing user message without mutating the input', () => {
    const input = [
      { role: 'user', content: 'q' },
      { role: 'tool', content: [] }
    ] as const
    const out = withCitationReminder(input)
    expect(input).toHaveLength(2)
    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({ role: 'user', content: getCitationReminderText() })
  })
})
