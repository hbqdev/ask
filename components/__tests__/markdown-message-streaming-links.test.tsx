import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SearchResultItem } from '@/lib/types'

import { MarkdownMessage } from '../message'

// The answer renders through Streamdown in streaming mode on BOTH the live
// stream and the persisted (reloaded) message. A citation anchor
// `[1](#<toolCallId>)` cut off at the stream tail used to be completed by
// Streamdown as `[1](streamdown:incomplete-link)`; sanitize stripped that
// href and rehype-harden rendered the href-less link as "1 [blocked]" until
// the anchor finished. These pin the fix and the link-safety it must not cost.

const citationMaps: Record<string, Record<number, SearchResultItem>> = {
  call_abc123: {
    1: {
      title: 'Example',
      url: 'https://example.com/a',
      content: 'c'
    } as SearchResultItem
  }
}

const PREFIX = 'Most organizations target weekly cadences. '

function renderAnswer(message: string) {
  return render(
    <MarkdownMessage message={message} citationMaps={citationMaps} />
  ).container
}

describe('MarkdownMessage: citation anchor cut off at the stream tail', () => {
  const tails = ['[', '[1', '[1](', '[1](#', '[1](#call_ab', '[1](#call_abc123']

  for (const tail of tails) {
    it(`renders nothing for the partial anchor ${JSON.stringify(tail)}`, () => {
      const container = renderAnswer(PREFIX + tail)
      expect(container.textContent).not.toContain('[blocked]')
      expect(container.querySelector('[title^="Blocked URL"]')).toBeNull()
      // Nothing of the partial anchor leaks: the text ends at the prose.
      expect(container.textContent?.trim()).toBe(PREFIX.trim())
    })
  }

  it('renders the source chip once the anchor completes', () => {
    const container = renderAnswer(PREFIX + '[1](#call_abc123)')
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.com/a')
    expect(a?.textContent).toBe('example')
    expect(container.textContent).not.toContain('[blocked]')
  })

  it('keeps a completed citation and drops only the trailing partial one', () => {
    const container = renderAnswer(
      PREFIX + '[1](#call_abc123) More text [1](#call_a'
    )
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.textContent).not.toContain('[blocked]')
    expect(container.textContent?.trim().endsWith('More text')).toBe(true)
  })
})

describe('MarkdownMessage: any link cut off at the stream tail', () => {
  it('shows an unfinished external link as its text, not "[blocked]"', () => {
    const container = renderAnswer('See the [Python docs](https://docs.pyth')
    expect(container.textContent).not.toContain('[blocked]')
    expect(container.textContent).toContain('Python docs')
    expect(container.querySelector('a')).toBeNull()
  })
})

describe('MarkdownMessage: link safety is unchanged', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd'
  ])('still blocks a completed %s link', href => {
    const container = renderAnswer(`Click [here](${href}) now.`)
    const anchors = [...container.querySelectorAll('a')]
    for (const a of anchors) {
      const h = a.getAttribute('href') ?? ''
      expect(h).not.toMatch(/^(javascript|data|vbscript|file):/i)
    }
  })

  it('still renders a normal external link as a link', () => {
    const container = renderAnswer(
      'Read [the guide](https://example.org/guide) today.'
    )
    const a = container.querySelector('a')
    expect(a?.getAttribute('href')).toBe('https://example.org/guide')
  })
})
