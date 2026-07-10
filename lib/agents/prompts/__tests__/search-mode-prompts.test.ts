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
