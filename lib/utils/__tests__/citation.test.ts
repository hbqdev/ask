import { describe, expect, it } from 'vitest'

import type { SearchResultItem } from '@/lib/types'
import type { UIMessage } from '@/lib/types/ai'

import {
  collapseCitationArtifacts,
  extractCitationMaps,
  isCitationLabel,
  processCitations
} from '../citation'

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

  // A model that writes `[1]` without the anchor produces text that LOOKS
  // cited and links nowhere — the anchored replacement never matches it.
  // Measured on a 16-probe pipeline run: 1 of 14 sourced answers came back
  // with 18 bare markers and zero anchored ones.
  describe('bare citations with a single source of truth', () => {
    it('resolves a bare [N] when there is exactly one citation map', () => {
      const result = processCitations(
        'PostgreSQL 18.4 fixed 11 CVEs. [1] It needs no dump and restore. [2]',
        mockCitationMaps
      )
      expect(result).toBe(
        'PostgreSQL 18.4 fixed 11 CVEs. [google](https://www.google.com) ' +
          'It needs no dump and restore. [github](https://docs.github.com)'
      )
    })

    it('refuses to guess when several searches each have their own map', () => {
      // Two maps means a bare [1] could belong to either search. Attaching a
      // real URL to a claim it may not support is worse than a dead marker.
      const twoMaps = {
        toolCall1: mockCitationMaps.toolCall1,
        toolCall2: mockCitationMaps.toolCall1
      }
      const content = 'Ambiguous claim. [1]'
      expect(processCitations(content, twoMaps)).toBe(content)
    })

    it('leaves array indexing alone', () => {
      // The real false-positive risk: these answers routinely discuss code.
      // A citation is never preceded by a word character.
      const content = 'Use arr[1] and matches[2] to read them.'
      expect(processCitations(content, mockCitationMaps)).toBe(content)
    })

    it('leaves code blocks and inline spans untouched', () => {
      const content =
        'Like so:\n```js\nconst x = list[1]\n```\nor inline `items[2]` here. [3]'
      const result = processCitations(content, mockCitationMaps)
      expect(result).toContain('const x = list[1]')
      expect(result).toContain('`items[2]`')
      expect(result).toContain(
        '[stackoverflow](https://stackoverflow.com/questions/123)'
      )
    })

    it('leaves a number with no matching source exactly as written', () => {
      // Deleting it — as the anchored path does for an invalid citation —
      // would silently edit prose that may never have been a citation.
      const content = 'See footnote [47] below.'
      expect(processCitations(content, mockCitationMaps)).toBe(content)
    })

    it('still resolves anchored citations in the same pass', () => {
      const result = processCitations(
        'Anchored [1](#toolCall1) and bare [2] together.',
        mockCitationMaps
      )
      expect(result).toBe(
        'Anchored [google](https://www.google.com) and bare ' +
          '[github](https://docs.github.com) together.'
      )
    })
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
