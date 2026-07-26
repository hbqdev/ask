import { afterEach, describe, expect, it } from 'vitest'

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
      expect(prompt.toLowerCase()).toContain('snippets only')
    }
  })
})

// The depth-tiering line promised "crawled in full". With SEARCH_EXCERPTS_ENABLED
// that became false — the model receives the most query-relevant passages of each
// crawled page, not the page. Measured consequence: every excerpts turn ran a
// second search and then fired the fetch-for-depth instruction (2, 1 and 3 fetch
// calls, against zero on the control), because the model was told it had full
// pages and could see that it did not. The description has to track the flag.
describe('depth description tracks SEARCH_EXCERPTS_ENABLED', () => {
  afterEach(() => {
    delete process.env.SEARCH_EXCERPTS_ENABLED
  })

  it('claims full-page crawling only when excerpts are OFF', () => {
    delete process.env.SEARCH_EXCERPTS_ENABLED
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt).toContain('crawled in full')
      expect(prompt).not.toContain('most relevant passages')
    }
  })

  it('describes passages, not full pages, when excerpts are ON', () => {
    process.env.SEARCH_EXCERPTS_ENABLED = 'true'
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt).toContain('most relevant passages')
      expect(prompt).not.toContain('crawled in full')
    }
  })

  it('keeps fetch-for-depth available in both modes — it is the escape hatch', () => {
    // Excerpts make fetch MORE useful, not less: it is how the model gets a
    // whole page when passages genuinely are not enough. The fix is that the
    // model should reach for it deliberately, not because it was misinformed.
    for (const value of [undefined, 'true']) {
      if (value) process.env.SEARCH_EXCERPTS_ENABLED = value
      else delete process.env.SEARCH_EXCERPTS_ENABLED
      for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
        expect(prompt.toLowerCase()).toContain('fetch tool on its url')
      }
    }
  })

  it('treats any value other than the exact string true as off', () => {
    process.env.SEARCH_EXCERPTS_ENABLED = 'yes'
    expect(getAdaptiveModePrompt()).toContain('crawled in full')
  })
})

// Measured on prod: every research turn issued 3-5 fetch calls, and ALL 11 of
// 11 targeted pages the search stage had ALREADY crawled and reranked — two
// of them twice. 86-118KB re-downloaded per turn plus a round trip each.
//
// Cause: the fetch guidance said "use when you need deeper content analysis
// beyond search snippets" and "fetch the top 2-3 most relevant URLs". That is
// written for a snippet pipeline. Our first search returns fully crawled,
// reranked page content, so there is nothing deeper to get for a URL already
// in the results.
describe('fetch guidance does not re-fetch already-returned sources', () => {
  it('tells balanced + quality mode that search results are already full content', () => {
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt).toMatch(/already among those results/i)
    }
  })

  it('no longer instructs a blanket "fetch the top 2-3 URLs"', () => {
    expect(getAdaptiveModePrompt()).not.toMatch(
      /Fetch the top 2-3 most relevant/i
    )
  })

  it('still permits fetch for URLs NOT already returned', () => {
    // A user-supplied link, a citation found inside a source, a PDF: these are
    // the legitimate uses and must survive.
    for (const prompt of [getAdaptiveModePrompt(), getQualityModePrompt()]) {
      expect(prompt.toLowerCase()).toContain('fetch')
      expect(prompt).toMatch(
        /not already|user (provides|gives|supplies)|links? (to|out)/i
      )
    }
  })
})
