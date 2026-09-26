import { afterEach, describe, expect, it } from 'vitest'

import {
  auditCitations,
  PROMPT_EXAMPLE_FETCH_ID,
  PROMPT_EXAMPLE_SEARCH_ID
} from '@/lib/utils/citation'

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

// Documented follow-up under-searching: in the reasoning-off era, a large
// share of follow-ups the classifier flagged needsSources were answered with
// zero searches — the model leaned on prior conversation context instead of
// verifying a genuinely new fact. The clarify-your-own-answer exception must
// stay balanced by an explicit re-search nudge so the two pull against each
// other: clarify turns answer from context, fresh-fact turns still search.
describe('follow-up re-search nudge balances the clarify exception', () => {
  it('tells every search-advertising mode a new fact is not clarification', () => {
    for (const prompt of [
      getQuickModePrompt(),
      getAdaptiveModePrompt(),
      getQualityModePrompt()
    ]) {
      expect(prompt).toMatch(/needs a NEW fact is not clarification/i)
      expect(prompt).toMatch(
        /does not exempt you from verifying something new/i
      )
    }
  })

  it('keeps the clarify-your-own-answer exception alongside it', () => {
    for (const prompt of [
      getQuickModePrompt(),
      getAdaptiveModePrompt(),
      getQualityModePrompt()
    ]) {
      expect(prompt).toMatch(/clarifying your own prior answer/i)
    }
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

// Measured on the lab A/B (2026-09-26) and in prod history: models copied the
// examples' `<id-A>` / `<id-B>` placeholders verbatim (whole answers' citations
// dropped), and the prompts taught two numbering schemes — "one number per
// toolCallId, assigned sequentially" (speed) vs "result order within each
// search" (balanced) — while the renderer implements only the second. Models
// numbering as a running count cited a one-page fetch as [3] (dropped) and a
// search's "5th source" as [5] (rendered as that search's 5th result).
describe('citation examples match what the renderer resolves', () => {
  const ANCHOR_RE = /\[\s*(\d+)\s*\]\(#([^)]+)\)/g
  const HAS_ANCHOR_RE = /\[\s*\d+\s*\]\(#[^)]+\)/
  const prompts = () => ({
    speed: getQuickModePrompt(),
    balanced: getAdaptiveModePrompt(),
    quality: getQualityModePrompt()
  })

  it('contains no copyable placeholder ids or retired example ids', () => {
    for (const prompt of Object.values(prompts())) {
      expect(prompt).not.toContain('<id-')
      expect(prompt).not.toMatch(/\(#<[^)]*>\)/)
      expect(prompt).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
      expect(prompt).not.toContain('mK3pQr7sT9uV2wX4')
    }
  })

  it('uses only the two worked-example ids in citation examples', () => {
    for (const prompt of Object.values(prompts())) {
      const ids = new Set([...prompt.matchAll(ANCHOR_RE)].map(m => m[2]))
      expect(ids.size).toBeGreaterThan(0)
      for (const id of ids) {
        expect([PROMPT_EXAMPLE_SEARCH_ID, PROMPT_EXAMPLE_FETCH_ID]).toContain(
          id
        )
      }
    }
  })

  it('states one numbering scheme: position within that call, restarting at 1', () => {
    for (const prompt of Object.values(prompts())) {
      expect(prompt).toMatch(/NOT a running count across your answer/)
      expect(prompt).toMatch(/numbering starts again at 1 for every/i)
      expect(prompt).toMatch(/always cited as \[1\]/)
      expect(prompt).not.toMatch(/Each unique toolCallId gets ONE number/i)
      expect(prompt).not.toMatch(/Assign numbers sequentially/i)
    }
  })

  it('every non-WRONG example anchor renders under the worked example it describes', () => {
    // The worked example: a search with 8 results and a fetch of one page.
    // Every example the prompt presents as correct must resolve, as written,
    // against exactly that turn — the renderer's own resolution, not a copy.
    const turn = [
      {
        type: 'tool-search',
        toolCallId: PROMPT_EXAMPLE_SEARCH_ID,
        state: 'output-available',
        output: {
          results: Array.from({ length: 8 }, (_, i) => ({
            title: `r${i + 1}`,
            url: `https://example.com/${i + 1}`,
            content: ''
          }))
        }
      },
      {
        type: 'tool-fetch',
        toolCallId: PROMPT_EXAMPLE_FETCH_ID,
        state: 'output-available',
        output: {
          results: [{ title: 'p', url: 'https://example.org/p', content: '' }]
        }
      }
    ]
    for (const [mode, prompt] of Object.entries(prompts())) {
      const correctLines = prompt
        .split('\n')
        .filter(line => !line.includes('✗') && HAS_ANCHOR_RE.test(line))
      const audit = auditCitations({
        parts: [...turn, { type: 'text', text: correctLines.join('\n') }]
      })
      expect({ mode, ...audit }).toEqual({
        mode,
        total: audit.total,
        own: audit.total,
        recovered: 0,
        unresolved: 0
      })
      // A fetch of one page is only ever shown as [1] outside WRONG examples.
      for (const line of correctLines) {
        for (const m of line.matchAll(ANCHOR_RE)) {
          if (m[2] === PROMPT_EXAMPLE_FETCH_ID) expect(m[1]).toBe('1')
        }
      }
    }
  })
})
