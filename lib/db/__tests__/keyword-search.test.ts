import { describe, expect, it } from 'vitest'

import {
  extractSnippet,
  type KeywordContentRow,
  type KeywordTitleRow,
  mergeKeywordSearchArms
} from '../keyword-search'

const contentRow = (
  chatId: string,
  overrides: Partial<KeywordContentRow> = {}
): KeywordContentRow => ({
  chatId,
  chatTitle: `Title ${chatId}`,
  snippet: `the answer about ${chatId} lives in this message body`,
  role: 'assistant',
  lastViewedAt: null,
  ...overrides
})

const titleRow = (
  chatId: string,
  overrides: Partial<KeywordTitleRow> = {}
): KeywordTitleRow => ({
  chatId,
  chatTitle: `Title ${chatId}`,
  lastViewedAt: null,
  ...overrides
})

describe('mergeKeywordSearchArms', () => {
  it('returns BOTH a title-match and a content-match chat, deduped, each with a snippet', () => {
    // c1 matched only in message text; c2 matched only on its title.
    const content = [contentRow('c1', { snippet: 'talk about backups here' })]
    const title = [titleRow('c2', { chatTitle: 'Backups checklist' })]

    const res = mergeKeywordSearchArms(content, title, 'backups', 20)

    expect(res.map(r => r.chatId).sort()).toEqual(['c1', 'c2'])
    const c1 = res.find(r => r.chatId === 'c1')!
    const c2 = res.find(r => r.chatId === 'c2')!
    // Content match → snippet drawn from the message body.
    expect(c1.snippet).toContain('backups')
    expect(c1.role).toBe('assistant')
    // Title-only match → snippet drawn from the title, role defaults to 'user'.
    expect(c2.snippet).toBe('Backups checklist')
    expect(c2.role).toBe('user')
  })

  it('prefers the content-arm row on collision so the snippet is the matching message', () => {
    // Same chat surfaced by both arms.
    const content = [
      contentRow('c1', {
        chatTitle: 'My Chat',
        snippet: 'the message body that matched the query'
      })
    ]
    const title = [titleRow('c1', { chatTitle: 'My Chat' })]

    const res = mergeKeywordSearchArms(content, title, 'query', 20)

    expect(res).toHaveLength(1)
    expect(res[0].chatId).toBe('c1')
    // Snippet is the message body (content arm), not the title (title arm).
    expect(res[0].snippet).toContain('message body')
    expect(res[0].role).toBe('assistant')
  })

  it('orders most-recently-viewed first with NULL lastViewedAt last', () => {
    const content = [
      contentRow('older', { lastViewedAt: new Date('2026-01-01') }),
      contentRow('newest', { lastViewedAt: new Date('2026-08-01') })
    ]
    const title = [titleRow('never', { lastViewedAt: null })]

    const res = mergeKeywordSearchArms(content, title, 'x', 20)

    expect(res.map(r => r.chatId)).toEqual(['newest', 'older', 'never'])
  })

  it('respects the limit after merge + ordering', () => {
    const content = [
      contentRow('a', { lastViewedAt: new Date('2026-01-03') }),
      contentRow('b', { lastViewedAt: new Date('2026-01-02') })
    ]
    const title = [titleRow('c', { lastViewedAt: new Date('2026-01-01') })]

    const res = mergeKeywordSearchArms(content, title, 'x', 2)

    expect(res.map(r => r.chatId)).toEqual(['a', 'b'])
  })

  it('falls back to the title when a content row has a null snippet', () => {
    const content = [
      contentRow('c1', { chatTitle: 'Fallback Title', snippet: null })
    ]

    const res = mergeKeywordSearchArms(content, [], 'nomatch', 20)

    expect(res[0].snippet).toBe('Fallback Title')
  })

  it('defaults role to "user" when a content row has a null role', () => {
    const content = [contentRow('c1', { role: null })]

    const res = mergeKeywordSearchArms(content, [], 'x', 20)

    expect(res[0].role).toBe('user')
  })
})

describe('extractSnippet', () => {
  it('centres ~150 chars on the first match with ellipses', () => {
    const text = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200)
    const snip = extractSnippet(text, 'needle')

    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip).toContain('NEEDLE')
    // ~150 chars of context plus the two ellipsis characters.
    expect(snip.length).toBeLessThanOrEqual(152)
  })

  it('returns a leading slice when the query is not present', () => {
    const text = 'a'.repeat(300)
    const snip = extractSnippet(text, 'zzz')

    expect(snip.length).toBe(150)
    expect(snip.startsWith('…')).toBe(false)
  })
})
