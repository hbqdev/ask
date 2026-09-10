import { describe, expect, it } from 'vitest'

import {
  looksLikeNarrationStart,
  stripNarrationPreamble
} from '../strip-narration-preamble'

describe('stripNarrationPreamble', () => {
  it('returns text unchanged when there is no ## heading', () => {
    const refusal = 'I cannot fulfill this request.'
    expect(stripNarrationPreamble(refusal)).toBe(refusal)
  })

  it('returns text unchanged when the heading is at the very start', () => {
    const clean = '## Capital of Japan\n\nThe capital of Japan is **Tokyo**.'
    expect(stripNarrationPreamble(clean)).toBe(clean)
  })

  it('strips a gemma4-style narration preamble before the heading', () => {
    const bad =
      'I have enough information to construct a comprehensive answer.\n' +
      '\n' +
      'Summary of findings:\n' +
      '- **Immediate Relief (OTC):** ...\n' +
      '\n' +
      'Wait, the prompt says ...\n' +
      'Actually, looking back at the tool history ...\n' +
      "Let's refine the content.\n" +
      '- **OTC:** ...\n' +
      'I have enough info. I will now write the response.\n' +
      '## Remedying Canker Sores: Effective Treatments and Tips 🦷\n' +
      '\n' +
      'Canker sores (aphthous ulcers) are non-contagious...'
    const out = stripNarrationPreamble(bad)
    expect(out.startsWith('## Remedying Canker Sores')).toBe(true)
    expect(out).not.toMatch(/I have enough information/)
    expect(out).not.toMatch(/Summary of findings/)
    expect(out).not.toMatch(/Let'?s refine/)
    expect(out).not.toMatch(/I will now write the response/)
  })

  it('does NOT strip a real intro paragraph before the first heading', () => {
    const real =
      'Canker sores are painful ulcers that affect many people.\n' +
      '\n' +
      '## Background\n' +
      '\n' +
      'They typically resolve within two weeks.'
    // "Canker sores are painful..." is a genuine intro, not a narration
    // pattern, so it should be preserved.
    expect(stripNarrationPreamble(real)).toBe(real)
  })

  it('returns empty string for empty input', () => {
    expect(stripNarrationPreamble('')).toBe('')
  })

  it('handles only-narration-no-heading without stripping (refusal safety)', () => {
    // No ## heading, so we can't tell where the answer starts. Don't risk
    // dropping a real refusal.
    const longRefusal =
      'I cannot fulfill this request. I am programmed to be a helpful and ' +
      'harmless AI assistant. My safety guidelines prohibit me from ' +
      'engaging with that kind of content. Please ask me something else.'
    expect(stripNarrationPreamble(longRefusal)).toBe(longRefusal)
  })

  it('strips at the FIRST ## when multiple headings exist', () => {
    const text =
      'Let me synthesize the findings.\n' +
      '- bullet\n' +
      '## Section 1\n' +
      'content 1\n' +
      '## Section 2\n' +
      'content 2'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Section 1')).toBe(true)
    expect(out).toContain('## Section 2')
    expect(out).toContain('content 1')
    expect(out).toContain('content 2')
  })

  it('matches the Now I will / I will now pattern', () => {
    const text =
      'Now I will write the response.\n' + '## Answer\n' + 'Here it is.'
    const out = stripNarrationPreamble(text)
    expect(out).toBe('## Answer\nHere it is.')
  })

  it('matches the Based on my research pattern', () => {
    const text =
      'Based on my research, here is what I found.\n' +
      '## Findings\n' +
      '- point'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Findings')).toBe(true)
  })

  it('strips a "let me search for more" preamble (round-cap / single-pass leak)', () => {
    // The single-pass regression: a round-capped turn where the model wanted
    // another search narrated it before the answer.
    const text =
      'Let me search for more recent sources to confirm this.\n' +
      '## Node.js LTS Versions\n' +
      'The current LTS is Node 24.'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Node.js LTS Versions')).toBe(true)
    expect(out).not.toMatch(/Let me search/)
  })

  it('strips an "I\'ll look for additional information" preamble', () => {
    const text =
      "I'll look for additional details on pricing before finalizing.\n" +
      '## Apple September 2026 Event\n' +
      'Apple announced...'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Apple September 2026 Event')).toBe(true)
    expect(out).not.toMatch(/look for additional/)
  })

  it('strips the "I have comprehensive data now. Let me..." family (live deepseek-v4-flash leak)', () => {
    // Verbatim shape captured on a round-capped GPU-comparison turn: the model
    // narrates that it has finished researching in the text part before the
    // `## ` heading, then writes the report.
    const text =
      'I have comprehensive data now. Let me note the key finding: the Arc B770 is not a released product. Let me construct the comparison.\n' +
      '## Intel Arc B770 vs. RTX 5060\n' +
      'Here is the comparison.'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Intel Arc B770')).toBe(true)
    expect(out).not.toMatch(/comprehensive data now/)
  })

  it('strips "I now have good coverage" and "I\'ll research ..." openers', () => {
    for (const preamble of [
      'I now have good coverage from the search results. Let me write it up.',
      "I'll research these three GPUs for a 1440p comparison. Let me search for current info.",
      'I have detailed specs for all three cards.'
    ]) {
      const text = `${preamble}\n## Report\nBody.`
      expect(stripNarrationPreamble(text).startsWith('## Report')).toBe(true)
    }
  })

  it('does NOT strip a genuine "Let me explain" intro before a heading', () => {
    // "explain" is not a search/lookup verb, so this genuine intro is kept.
    const text =
      'Let me explain how the two approaches differ.\n' +
      '## Comparison\n' +
      'They differ in three ways.'
    expect(stripNarrationPreamble(text)).toBe(text)
  })

  it('does not crash on nullish or non-string input', () => {
    // Defensive: callers may pass unexpected values.
    expect(stripNarrationPreamble(null as any)).toBe(null)
    expect(stripNarrationPreamble(undefined as any)).toBe(undefined)
  })

  it('strips narration when ## is preceded by a <channel|> marker', () => {
    // The Vercel AI SDK data-stream protocol emits channel-switch tokens
    // like `<channel|>` between text-delta chunks when the model emits
    // non-text parts in the same step. The text part content gets these
    // markers concatenated in. We must strip past them.
    const text =
      'I have enough info. I will now write the response.<channel|>## Answer\n' +
      'Here is the answer.'
    const out = stripNarrationPreamble(text)
    expect(out).toBe('## Answer\nHere is the answer.')
  })

  it('strips narration when ## is preceded by a closing think-tag with no newline', () => {
    // Real bug observed with minimax-m3:cloud in production: the model's
    // reasoning arrives inline in the text part (not as a separate
    // reasoning part) and is closed with a custom tag directly butted up
    // against the heading — "...bullets.</mm:think>## Why Super Flower's
    // Warranty Process Sucks" — with no newline in between. The regex
    // must recognize this boundary the same way it does <channel|>.
    const text =
      "Let me synthesize what I've found. No need for heavy subheadings.</mm:think>## Why Super Flower's Warranty Process Sucks\n" +
      "Yeah, you're not alone in that frustration."
    const out = stripNarrationPreamble(text)
    expect(out.startsWith("## Why Super Flower's Warranty Process Sucks")).toBe(
      true
    )
    expect(out).not.toMatch(/Let me synthesize/)
    expect(out).not.toMatch(/mm:think/)
  })

  it('strips narration even when preceded by an unrelated garbled first sentence', () => {
    // Real bug observed with gemma4:31b:cloud: the model prepends an
    // unrelated or garbled sentence before its actual self-talk kicks in,
    // e.g. "Coins are not mentioned yet." before "I have enough search
    // results...". A whole-string ^-anchored check on the full preamble
    // misses this since the narration pattern isn't at position 0 of the
    // preamble — looksLikeNarrationStart must check each sentence.
    const text =
      'Coins are not mentioned yet. I have enough search results from the ' +
      'first call to provide a comprehensive answer. The first search ' +
      'result covers general causes, triggers, and nutritional deficiencies.\n' +
      '\n' +
      'Wait, I should be thorough. I want to make sure I distinguish between ' +
      '"cause" (unknown) and "triggers" (known).\n' +
      '\n' +
      "I'll write the final answer now.\n" +
      '## Causes and Triggers of Canker Sores 👄\n' +
      '\n' +
      'While the exact cause is not fully understood...'
    const out = stripNarrationPreamble(text)
    expect(out.startsWith('## Causes and Triggers of Canker Sores')).toBe(true)
    expect(out).not.toMatch(/Coins are not mentioned/)
    expect(out).not.toMatch(/I have enough search results/)
  })
})

describe('looksLikeNarrationStart', () => {
  it('matches when the whole string starts with a narration pattern', () => {
    expect(looksLikeNarrationStart('I have enough info to answer.')).toBe(true)
  })

  it('matches when a narration pattern appears at a later sentence boundary', () => {
    expect(
      looksLikeNarrationStart(
        'Coins are not mentioned yet. I have enough search results.'
      )
    ).toBe(true)
  })

  it('matches across a newline boundary, not just ". "', () => {
    expect(
      looksLikeNarrationStart('Some garbled text\nLet me synthesize this.')
    ).toBe(true)
  })

  it('matches "let me search" / "I\'ll look for" search-narration shapes', () => {
    expect(looksLikeNarrationStart('Let me search for more sources.')).toBe(true)
    expect(looksLikeNarrationStart("I'll look for additional details.")).toBe(
      true
    )
    expect(
      looksLikeNarrationStart('Let me do one more search to be thorough.')
    ).toBe(true)
    expect(looksLikeNarrationStart('I need to verify this first.')).toBe(true)
  })

  it('does not match genuine "let me explain"/"let me show" intros', () => {
    expect(looksLikeNarrationStart('Let me explain the difference.')).toBe(false)
    expect(looksLikeNarrationStart('Let me show you the results.')).toBe(false)
    expect(looksLikeNarrationStart('Let me walk through the options.')).toBe(
      false
    )
  })

  it('matches the "I have comprehensive/good/detailed ... data" research-done family', () => {
    expect(looksLikeNarrationStart('I have comprehensive data now.')).toBe(true)
    expect(looksLikeNarrationStart('I now have good coverage of the topic.')).toBe(
      true
    )
    expect(looksLikeNarrationStart('I have detailed specs for all three.')).toBe(
      true
    )
    expect(looksLikeNarrationStart("I'll research these GPUs.")).toBe(true)
  })

  it('does not match genuine content that merely mentions having data', () => {
    expect(
      looksLikeNarrationStart('The RTX 5060 is a solid mid-range card.')
    ).toBe(false)
    // "I have three picks" is an answer opener, not research narration.
    expect(looksLikeNarrationStart('I have three recommendations for you.')).toBe(
      false
    )
  })

  it('does not match a narration phrase appearing mid-sentence (not at a boundary)', () => {
    expect(
      looksLikeNarrationStart('The doctor said I have enough vitamins.')
    ).toBe(false)
  })

  it('does not match genuine content with no narration pattern anywhere', () => {
    expect(
      looksLikeNarrationStart(
        'Canker sores are painful ulcers that affect many people.'
      )
    ).toBe(false)
  })

  it('returns false for empty or whitespace-only input', () => {
    expect(looksLikeNarrationStart('')).toBe(false)
    expect(looksLikeNarrationStart('   ')).toBe(false)
  })
})
