import { describe, expect, it } from 'vitest'

import {
  getAdaptiveModePrompt,
  getQualityModePrompt,
  getQuickModePrompt
} from '../search-mode-prompts'

// Regression guard for a real production issue: models were decorating most
// headings with emojis and reaching for tables on casual/lifestyle
// questions, despite prompt text that "discouraged" it with soft qualifiers
// ("sparingly", "when in doubt"). The fix replaced that with a hard cap and
// explicit density guidance — these tests make sure both mode prompts (and
// Quality mode, which builds on Balanced) keep the stricter wording.
describe('search mode prompt emoji/density guidance', () => {
  it('caps Quick mode to at most one emoji, defaulting to none', () => {
    const prompt = getQuickModePrompt()

    expect(prompt).toMatch(/Default to NO emojis/i)
    expect(prompt).toMatch(/AT MOST ONE emoji/i)
    expect(prompt).not.toMatch(/use them sparingly/i)
  })

  it('caps Balanced mode to at most one emoji, defaulting to none', () => {
    const prompt = getAdaptiveModePrompt()

    expect(prompt).toMatch(/Default to NO emojis/i)
    expect(prompt).toMatch(/AT MOST ONE emoji/i)
    expect(prompt).not.toMatch(/use them sparingly/i)
  })

  it('scales structural density to topic tone in both modes', () => {
    expect(getQuickModePrompt()).toMatch(/Match structural density/i)
    expect(getAdaptiveModePrompt()).toMatch(/Match structural density/i)
  })

  it('Quality mode inherits the stricter emoji guidance from Balanced mode', () => {
    const prompt = getQualityModePrompt()

    expect(prompt).toMatch(/Default to NO emojis/i)
    expect(prompt).toMatch(/AT MOST ONE emoji/i)
  })
})

// Regression guard for a real production issue: Quality mode's 15-30+
// search/fetch rounds each ended with a short narration line ("Let me
// search for...", "Good, I have some results..."). The UI already hides
// these from the final rendered transcript, but while the response is
// still streaming, each one is briefly visible before being superseded by
// the next tool round — there's no way to know client-side that a given
// text chunk isn't the final answer until more parts arrive. The real fix
// is to stop the model from narrating between rounds at all.
describe('Quality mode silent-execution guidance', () => {
  it('instructs the model not to narrate between tool calls', () => {
    const prompt = getQualityModePrompt()

    expect(prompt).toMatch(/no narration between tool calls/i)
    expect(prompt).toMatch(/Call tools back-to-back silently/i)
  })
})

// Regression guard: the model was re-running searches to get more depth on
// a promising result instead of using fetch, wasting a search call every
// time. Balanced and Quality mode prompts must both explain that only the
// first search of a turn crawls in full (depth tiering) and that fetch is
// the right tool for reading a specific URL in full afterward.
describe('depth-tiering and fetch-for-depth guidance', () => {
  it('balanced + quality prompts explain depth tiering and fetch-for-depth', () => {
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt.toLowerCase()).toContain('first search')
      expect(prompt.toLowerCase()).toContain('fetch')
    }
  })
})
