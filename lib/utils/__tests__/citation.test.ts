import { describe, expect, it } from 'vitest'

import type { SearchResultItem } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'

import {
  auditCitations,
  collapseCitationArtifacts,
  extractCitationMaps,
  extractCitedSourceUrls,
  isCitationLabel,
  processCitations,
  resolveByUrlFragment,
  stripIncompleteCitationTail
} from '../citation'

describe('stripIncompleteCitationTail', () => {
  it.each([
    ['text. [', 'text. '],
    ['text. [1', 'text. '],
    ['text. [ 12 ', 'text. '],
    ['text. [1](', 'text. '],
    ['text. [1](#', 'text. '],
    ['text. [1](#call_ab', 'text. '],
    ['text.[2](#1f0e-9c2a', 'text.'],
    ['a [1](#x) b [2](#call_a', 'a [1](#x) b ']
  ])('drops the unfinished anchor in %j', (input, expected) => {
    expect(stripIncompleteCitationTail(input)).toBe(expected)
  })

  it.each([
    'text. [1](#call_abc)', // complete anchor
    'see note [1]', // complete bracket with no link part: literal text
    'the [Python docs', // a named link, not a citation
    'text [1](https://exa', // an external link, not a citation anchor
    'text [1](#call_abc) more',
    '```py\nx = [1', // open fenced code block
    'use `arr[1', // open inline code span
    ''
  ])('leaves %j unchanged', input => {
    expect(stripIncompleteCitationTail(input)).toBe(input)
  })
})

describe('processCitations', () => {
  const mockCitationMaps = {
    toolCall1: {
      1: {
        title: 'Google',
        url: 'https://www.google.com',
        content: 'Search engine'
      },
      2: {
        title: 'GitHub',
        url: 'https://docs.github.com',
        content: 'Developer platform'
      },
      3: {
        title: 'Stack Overflow',
        url: 'https://stackoverflow.com/questions/123',
        content: 'Q&A for developers'
      }
    } as Record<number, SearchResultItem>
  }

  it('converts numbered citations to domain names', () => {
    const content = 'Check out [1](#toolCall1) and [2](#toolCall1)'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe(
      'Check out [google](https://www.google.com) and [github](https://docs.github.com)'
    )
  })

  it('handles citations with spaces', () => {
    const content = 'See [ 1 ](#toolCall1) for details'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe('See [google](https://www.google.com) for details')
  })

  it('handles multiple citations from same domain', () => {
    const citationMaps = {
      toolCall1: {
        1: {
          title: 'Google Search',
          url: 'https://www.google.com/search',
          content: 'Search'
        },
        2: {
          title: 'Google Maps',
          url: 'https://www.google.com/maps',
          content: 'Maps'
        }
      } as Record<number, SearchResultItem>
    }

    const content = 'Try [1](#toolCall1) or [2](#toolCall1)'
    const result = processCitations(content, citationMaps)

    expect(result).toBe(
      'Try [google](https://www.google.com/search) or [google](https://www.google.com/maps)'
    )
  })

  it('converts citations with dotted display labels', () => {
    const citationMaps = {
      toolCall1: {
        1: {
          title: 'Global News',
          url: 'https://topics.global.example.com/portal/news/page.html',
          content: 'News article'
        },
        2: {
          title: 'World Report',
          url: 'https://articles.world.example.net/articles/-/123',
          content: 'News article'
        }
      } as Record<number, SearchResultItem>
    }

    const content = 'Sources [1](#toolCall1) [2](#toolCall1)'
    const result = processCitations(content, citationMaps)

    expect(result).toBe(
      'Sources [global.example](https://topics.global.example.com/portal/news/page.html) [world.example](https://articles.world.example.net/articles/-/123)'
    )
  })

  it('returns empty string for invalid citation numbers', () => {
    const content = 'Invalid [999](#toolCall1) citation'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe('Invalid  citation')
  })

  it('returns empty string for missing toolCallId', () => {
    const content = 'Missing [1](#nonExistentTool) tool'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe('Missing  tool')
  })

  it('returns empty string for invalid URLs', () => {
    const citationMaps = {
      toolCall1: {
        1: {
          title: 'Invalid',
          url: 'not-a-valid-url',
          content: 'Invalid URL'
        }
      } as Record<number, SearchResultItem>
    }

    const content = 'Check [1](#toolCall1) here'
    const result = processCitations(content, citationMaps)

    expect(result).toBe('Check  here')
  })

  it('resolves citations where the model prepended a toolu_ prefix', () => {
    // Models sometimes cite [1](#toolu_<id>) even though the search tool's
    // call id has no prefix. The cited id should still resolve to the result.
    const content = 'See [1](#toolu_toolCall1) and [2](#toolu_toolCall1)'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe(
      'See [google](https://www.google.com) and [github](https://docs.github.com)'
    )
  })

  it('still prefers an exact toolCallId match over a normalized one', () => {
    const content = 'See [1](#toolCall1)'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe('See [google](https://www.google.com)')
  })

  it('handles content with no citations', () => {
    const content = 'This is plain text without citations'
    const result = processCitations(content, mockCitationMaps)

    expect(result).toBe('This is plain text without citations')
  })

  it('returns empty string for null/undefined content', () => {
    expect(processCitations('', mockCitationMaps)).toBe('')
    expect(processCitations(null as any, mockCitationMaps)).toBe('')
  })

  it('handles empty citation maps', () => {
    const content = 'Text with [1](#toolCall1) citation'
    const result = processCitations(content, {})

    // When citation maps are empty, content is returned unchanged
    expect(result).toBe('Text with [1](#toolCall1) citation')
  })

  it('encodes URLs to prevent injection', () => {
    const citationMaps = {
      toolCall1: {
        1: {
          title: 'Test',
          url: 'https://example.com/page?param=value&other=test',
          content: 'Test'
        }
      } as Record<number, SearchResultItem>
    }

    const content = 'See [1](#toolCall1)'
    const result = processCitations(content, citationMaps)

    expect(result).toContain('example')
    expect(result).toContain('https://example.com/page?param=value&other=test')
  })

  it('handles complex real-world scenarios', () => {
    const content = `According to [1](#toolCall1), the answer is 42.
    However, [2](#toolCall1) suggests otherwise.
    For more information, see [3](#toolCall1).`

    const result = processCitations(content, mockCitationMaps)

    expect(result).toContain('[google](https://www.google.com)')
    expect(result).toContain('[github](https://docs.github.com)')
    expect(result).toContain(
      '[stackoverflow](https://stackoverflow.com/questions/123)'
    )
  })

  it('handles citation numbers at edge cases', () => {
    const content =
      'Edge cases: [0](#toolCall1) [101](#toolCall1) [-1](#toolCall1)'
    const result = processCitations(content, mockCitationMaps)

    // 0 and 101 are out of bounds (1-100), so they're replaced with empty string
    // -1 doesn't match the regex pattern \d+, so it remains unchanged
    expect(result).toBe('Edge cases:   [-1](#toolCall1)')
  })

  describe('extractCitationMaps', () => {
    const results = [
      { title: 'Google', url: 'https://www.google.com', content: 'a' },
      { title: 'GitHub', url: 'https://docs.github.com', content: 'b' }
    ]

    function messageWithSearchPart(output: unknown): UIMessage {
      return {
        id: 'm1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-search',
            state: 'output-available',
            toolCallId: 'toolCall1',
            output
          }
        ]
      } as unknown as UIMessage
    }

    it('derives the citation map from results when citationMap is absent', () => {
      const maps = extractCitationMaps(
        messageWithSearchPart({ results, images: [], query: 'q' })
      )

      expect(maps.toolCall1[1]).toEqual(results[0])
      expect(maps.toolCall1[2]).toEqual(results[1])
    })

    it('prefers an existing citationMap (older persisted messages)', () => {
      const legacy = {
        1: { title: 'Legacy', url: 'https://legacy.example.com', content: 'c' }
      }
      const maps = extractCitationMaps(
        messageWithSearchPart({ results, citationMap: legacy })
      )

      expect(maps.toolCall1).toBe(legacy)
    })

    it('omits tool calls with no results and no citationMap', () => {
      const maps = extractCitationMaps(
        messageWithSearchPart({ results: [], images: [], query: 'q' })
      )

      expect(maps).toEqual({})
    })

    it('produces a map that processCitations can resolve', () => {
      const maps = extractCitationMaps(
        messageWithSearchPart({ results, images: [], query: 'q' })
      )
      const result = processCitations('See [1](#toolCall1)', maps)

      expect(result).toBe('See [google](https://www.google.com)')
    })
  })

  describe('isCitationLabel', () => {
    it('accepts numeric, simple domain, and dotted domain labels', () => {
      expect(isCitationLabel('1')).toBe(true)
      expect(isCitationLabel('youtube')).toBe(true)
      expect(isCitationLabel('global.example')).toBe(true)
      expect(isCitationLabel('world.example')).toBe(true)
    })

    it('rejects punctuation and whitespace outside the label', () => {
      expect(isCitationLabel('')).toBe(false)
      expect(isCitationLabel('global.example.')).toBe(false)
      expect(isCitationLabel('.global.example')).toBe(false)
      expect(isCitationLabel('global example')).toBe(false)
    })
  })

  describe('collapseCitationArtifacts', () => {
    it('collapses double spaces left by a stripped citation', () => {
      expect(collapseCitationArtifacts('text  more')).toBe('text more')
    })

    it('collapses ".."', () => {
      expect(collapseCitationArtifacts('text..')).toBe('text.')
    })

    it('fixes "text . word" artifact (model wrote "text ." before [1])', () => {
      // After processCitations strips [1](#fake) from "text .[1](#fake) more",
      // the artifact is "text . more". Collapse to "text. more".
      expect(collapseCitationArtifacts('text . more')).toBe('text. more')
    })

    it('preserves normal sentence breaks (no false positives)', () => {
      // A normal sentence "Hello. World" should NOT be collapsed to "Hello.World"
      expect(collapseCitationArtifacts('Hello. World')).toBe('Hello. World')
    })

    it('collapses ". ,more" pattern to ". more"', () => {
      // Model wrote "text. ,more" — the comma+space came from a stripped citation
      expect(collapseCitationArtifacts('text. ,more')).toBe('text. more')
    })

    it('preserves newlines (does not collapse them)', () => {
      expect(collapseCitationArtifacts('text\n\nmore')).toBe('text\n\nmore')
    })

    it('returns empty string for empty input', () => {
      expect(collapseCitationArtifacts('')).toBe('')
    })

    it('handles a realistic stripped-citation scenario', () => {
      // The bug report: model wrote "important fact.[1](#fetch_prevention) more
      // text" (or with a space before the bracket). After processCitations
      // strips the bracket, the result should be clean — no double spaces,
      // no double periods, no orphaned commas.
      const stripped = processCitations(
        'important fact.[1](#fake) more text',
        mockCitationMaps
      )
      const cleaned = collapseCitationArtifacts(stripped)
      expect(cleaned).not.toMatch(/  /) // no double spaces
      expect(cleaned).not.toMatch(/\.\./) // no double periods
      expect(cleaned).toMatch(/fact\.\s+more/) // period + whitespace + word
    })
  })
})

describe('auditCitations', () => {
  const msg = (parts: unknown[]) => ({ parts })

  it('counts an anchor naming this message own tool call as resolved', () => {
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'abc-123' },
        { type: 'text', text: 'A fact [1](#abc-123).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 1, recovered: 0, unresolved: 0 })
  })

  it('counts an invented slug as unresolved even when a real call exists', () => {
    // The observed failure: the turn fetched a page, had no citable anchor for
    // it under the old rules, and composed `fetch_1`.
    const result = auditCitations(
      msg([
        {
          type: 'tool-fetch',
          toolCallId: 'b55c29d0-2325-4dc9-a791-c62189549a0d'
        },
        { type: 'text', text: 'Per the page [1](#fetch_1).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 0, recovered: 0, unresolved: 1 })
  })

  it('counts an anchor from another turn as unresolved', () => {
    // The defect this instrumentation exists for: the id is real, it just
    // belongs to a different message, so a conversation-wide map resolved it
    // to the wrong source instead of failing.
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'this-turn' },
        { type: 'text', text: 'GPU spec [1](#previous-turn).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 0, recovered: 0, unresolved: 1 })
  })

  it('counts a fabricated anchor as unresolved', () => {
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'real-id' },
        { type: 'text', text: 'Claim [1](#aHvy9Vt17r3VSmnG).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 0, recovered: 0, unresolved: 1 })
  })

  it('ignores a bare anchor with no citation number, which is never processed', () => {
    // processCitations only acts on [N](#id). A bare (#id) stays literal text,
    // so counting it would inflate the denominator with something that never
    // had a chance to resolve.
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'abc-123' },
        { type: 'text', text: 'Loose reference (#abc-123) in prose.' }
      ])
    )

    expect(result).toEqual({ total: 0, own: 0, recovered: 0, unresolved: 0 })
  })

  it('resolves through a provider prefix on either side', () => {
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'toolu_abc-123' },
        { type: 'text', text: 'A [1](#abc-123) and B [2](#toolu_abc-123).' }
      ])
    )

    expect(result).toEqual({ total: 2, own: 2, recovered: 0, unresolved: 0 })
  })

  it('tallies a mix across several text parts', () => {
    const result = auditCitations(
      msg([
        { type: 'tool-search', toolCallId: 'own-1' },
        { type: 'tool-search', toolCallId: 'own-2' },
        { type: 'text', text: 'One [1](#own-1) two [2](#stale).' },
        { type: 'text', text: 'Three [3](#own-2) four [4](#made-up).' }
      ])
    )

    expect(result).toEqual({ total: 4, own: 2, recovered: 0, unresolved: 2 })
  })

  it('treats a fetch tool call as citable', () => {
    // Fetched pages return the same {results:[{title,url,content}]} shape as
    // search and are read to write the answer, so an anchor naming a fetch is
    // legitimate — not a fabrication.
    const result = auditCitations(
      msg([
        { type: 'tool-fetch', toolCallId: 'fetch-abc' },
        { type: 'text', text: 'From the page [1](#fetch-abc).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 1, recovered: 0, unresolved: 0 })
  })

  it('does not treat a non-citable tool as resolvable', () => {
    // calculate/get_weather/todoWrite carry toolCallIds but produce no citation
    // map, so counting them would make the audit disagree with rendering.
    const result = auditCitations(
      msg([
        { type: 'tool-calculate', toolCallId: 'calc-1' },
        { type: 'text', text: 'The total is 42 [1](#calc-1).' }
      ])
    )

    expect(result).toEqual({ total: 1, own: 0, recovered: 0, unresolved: 1 })
  })

  it('returns zeros for a message with no parts', () => {
    expect(auditCitations({})).toEqual({
      total: 0,
      own: 0,
      recovered: 0,
      unresolved: 0
    })
    expect(auditCitations({ parts: [] })).toEqual({
      total: 0,
      own: 0,
      recovered: 0,
      unresolved: 0
    })
  })
})

describe('URL-fragment anchors (resolveByUrlFragment)', () => {
  // Real prod shapes: the model could not see the fetch call's id, so it
  // named the page by (part of) its URL instead.
  const searchPart = (id: string, urls: string[]) => ({
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    output: {
      results: urls.map((url, i) => ({ title: `t${i}`, url, content: 'c' }))
    }
  })
  const zhihu = 'https://zhuanlan.zhihu.com/p/2022269238895736170'
  const bike = 'https://1up-usa.com/how-to-change-a-bike-tire'
  const maps = {
    's-1': {
      1: { title: 'a', url: zhihu, content: '' },
      2: { title: 'b', url: bike, content: '' },
      3: { title: 'c', url: 'https://learn.microsoft.com/a', content: '' },
      4: { title: 'd', url: 'https://learn.microsoft.com/b', content: '' }
    }
  }

  it('resolves an id that is a fragment of exactly one source URL', () => {
    expect(resolveByUrlFragment('2022269238895736170', maps)?.url).toBe(zhihu)
    expect(
      resolveByUrlFragment('1up-usa.com/how-to-change-a-bike-tire', maps)?.url
    ).toBe(bike)
    expect(
      resolveByUrlFragment(
        'https://www.1up-usa.com/how-to-change-a-bike-tire/',
        maps
      )?.url
    ).toBe(bike)
  })

  it('refuses ambiguous, short, UUID-shaped and invented ids', () => {
    expect(resolveByUrlFragment('learn.microsoft.com', maps)).toBeUndefined()
    expect(resolveByUrlFragment('zhihu', maps)).toBeUndefined() // < 6 chars
    expect(
      resolveByUrlFragment('46bdb6f3-94b7-4dca-93a3-1a1b95d4faf2', maps)
    ).toBeUndefined()
    expect(resolveByUrlFragment('fetched_brenndoerfer', maps)).toBeUndefined()
    expect(resolveByUrlFragment('aHvy9Vt17r3VSmnG', maps)).toBeUndefined()
  })

  it('processCitations renders a URL-fragment anchor as its source', () => {
    const out = processCitations(
      'Timeline. [9](#2022269238895736170) Invented. [1](#fetched_x)',
      maps
    )
    expect(out).toContain(`](${encodeURI(zhihu)})`)
    expect(out).not.toContain('fetched_x')
  })

  it('an own toolCallId still wins over URL matching', () => {
    const out = processCitations('Fact. [2](#s-1)', maps)
    expect(out).toContain(`](${encodeURI(bike)})`)
  })

  it('auditCitations counts a recovered anchor separately, not as unresolved', () => {
    const result = auditCitations({
      parts: [
        searchPart('s-1', [zhihu, bike]),
        {
          type: 'text',
          text: 'A [1](#s-1). B [9](#2022269238895736170). C [1](#made-up-id).'
        }
      ]
    })
    expect(result).toEqual({ total: 3, own: 1, recovered: 1, unresolved: 1 })
  })

  it('extractCitedSourceUrls includes a recovered source', () => {
    const urls = extractCitedSourceUrls({
      id: 'm',
      role: 'assistant',
      parts: [
        searchPart('s-1', [zhihu, bike]),
        { type: 'text', text: 'B [9](#2022269238895736170).' }
      ]
    } as any)
    expect(urls).toEqual([zhihu])
  })
})
