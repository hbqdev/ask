import { describe, expect, it } from 'vitest'

import {
  auditCitationEvidence,
  findPageTextForUrl,
  samePageKey,
  SNIPPET_MAX_CHARS
} from '../citation'

const msg = (parts: unknown[]) => ({ parts })
const SNIPPET = 's'.repeat(401)
const PAGE = 'p'.repeat(SNIPPET_MAX_CHARS + 1)

type R = { url: string; content: string; title?: string }
const part = (type: string, toolCallId: string, results: R[]) => ({
  type,
  toolCallId,
  state: 'output-available',
  output: {
    results: results.map((r, i) => ({ title: `${toolCallId} ${i + 1}`, ...r }))
  }
})
const search = (id: string, results: R[]) => part('tool-search', id, results)
const fetchPart = (id: string, results: R[]) => part('tool-fetch', id, results)
const text = (t: string) => ({ type: 'text', text: t })

describe('samePageKey', () => {
  it('ignores scheme, www, case, trailing slash and the fragment', () => {
    expect(samePageKey('http://WWW.Example.com/A/b/#top')).toBe(
      samePageKey('https://example.com/a/b')
    )
  })

  it('drops tracker and empty-valued query parameters, keeps order-free content ones', () => {
    // Observed on the lab 2026-09-30: search returned …/fulltext?rss=yes, the
    // model fetched …/fulltext.
    const lancet =
      'https://www.thelancet.com/journals/lancet/article/PIIS0140-6736(26)00305-3/fulltext'
    expect(samePageKey(`${lancet}?rss=yes`)).toBe(samePageKey(lancet))
    expect(samePageKey('https://x.com/p?utm_source=a&id=7&mal=')).toBe(
      samePageKey('https://x.com/p?id=7')
    )
    expect(samePageKey('https://x.com/p?b=2&a=1')).toBe(
      samePageKey('https://x.com/p?a=1&b=2')
    )
  })

  it('keeps content-selecting query parameters apart', () => {
    expect(samePageKey('https://youtube.com/watch?v=a')).not.toBe(
      samePageKey('https://youtube.com/watch?v=b')
    )
    expect(samePageKey('https://x.com/article.php?id=1')).not.toBe(
      samePageKey('https://x.com/article.php')
    )
  })

  it('treats a GitHub repo page, its tabs and its README blob as one page', () => {
    // Lab 2026-09-30 (D q3): the turn fetched onyx/khoj READMEs and cited the
    // repo pages' 400-char search snippets instead.
    const readme = samePageKey(
      'https://github.com/onyx-dot-app/onyx/blob/main/README.md'
    )
    expect(samePageKey('https://github.com/onyx-dot-app/onyx?mal=')).toBe(
      readme
    )
    expect(
      samePageKey('https://github.com/khoj-ai/khoj?tab=AGPL-3.0-1-ov-file')
    ).toBe(samePageKey('https://github.com/khoj-ai/khoj/blob/master/README.md'))
    // other files in the repo are other pages
    expect(
      samePageKey('https://github.com/onyx-dot-app/onyx/blob/main/LICENSE')
    ).not.toBe(readme)
    // and the tab rule is GitHub-only
    expect(samePageKey('https://x.com/p?tab=2')).not.toBe(
      samePageKey('https://x.com/p')
    )
  })

  it('returns null for anything that is not an http(s) URL', () => {
    expect(samePageKey('not a url')).toBeNull()
    expect(samePageKey('mailto:a@b.c')).toBeNull()
  })
})

describe('findPageTextForUrl', () => {
  it('finds a fetched copy of the cited page under another URL form', () => {
    const m = msg([
      search('s1', [{ url: 'https://github.com/o/r?mal=', content: SNIPPET }]),
      fetchPart('f1', [
        { url: 'https://github.com/o/r/blob/main/README.md', content: PAGE }
      ])
    ])
    expect(findPageTextForUrl('https://github.com/o/r?mal=', m)?.url).toBe(
      'https://github.com/o/r/blob/main/README.md'
    )
  })

  it('counts a crawled copy from another search as page text', () => {
    const m = msg([
      search('s1', [{ url: 'https://a.com/x', content: PAGE }]),
      search('s2', [{ url: 'https://a.com/x', content: SNIPPET }])
    ])
    expect(findPageTextForUrl('https://a.com/x', m)?.content).toBe(PAGE)
  })

  it('ignores snippets, other pages and failed-fetch placeholders', () => {
    const m = msg([
      search('s1', [{ url: 'https://a.com/x', content: SNIPPET }]),
      fetchPart('f1', [{ url: 'https://b.com/y', content: PAGE }]),
      fetchPart('f2', [
        {
          url: 'https://a.com/x',
          title: 'Fetch failed: https://a.com/x',
          content: 'Could not retrieve this page'
        }
      ])
    ])
    expect(findPageTextForUrl('https://a.com/x', m)).toBeUndefined()
  })
})

describe('auditCitationEvidence', () => {
  it('splits rendered anchors into page, snippet-read and snippet', () => {
    const m = msg([
      search('s1', [
        { url: 'https://crawled.com/a', content: PAGE }, // [1] page text
        { url: 'https://read.com/b', content: SNIPPET }, // [2] page fetched below
        { url: 'https://only.com/c', content: SNIPPET } // [3] snippet only
      ]),
      fetchPart('f1', [{ url: 'https://read.com/b', content: PAGE }]),
      text(
        'A. [1](#s1) B. [2](#s1) C. [3](#s1) D. [1](#f1) E. [9](#s1) F. [1](#ghost)'
      )
    ])
    expect(auditCitationEvidence(m)).toEqual({
      page: 2, // [1](#s1) crawled, [1](#f1) fetched
      snippetRead: 1,
      snippet: 1,
      fetchedPagesUncited: 0
    })
  })

  it('reports fetched pages no citation points to', () => {
    // The 2026-09-30 failure shape: pages fetched, snippets cited instead.
    const m = msg([
      search('s1', [{ url: 'https://other.com/a', content: SNIPPET }]),
      fetchPart('f1', [
        { url: 'https://read.com/1', content: PAGE },
        { url: 'https://read.com/2', content: PAGE }
      ]),
      text('Fact. [1](#s1) Another. [2](#f1)')
    ])
    expect(auditCitationEvidence(m)).toEqual({
      page: 1,
      snippetRead: 0,
      snippet: 1,
      fetchedPagesUncited: 1
    })
  })

  it('a snippet citation of a fetched page counts that page as cited', () => {
    const m = msg([
      search('s1', [{ url: 'https://github.com/o/r?tab=x', content: SNIPPET }]),
      fetchPart('f1', [
        { url: 'https://github.com/o/r/blob/master/README.md', content: PAGE }
      ]),
      text('Repo fact. [1](#s1)')
    ])
    expect(auditCitationEvidence(m)).toEqual({
      page: 0,
      snippetRead: 1,
      snippet: 0,
      fetchedPagesUncited: 0
    })
  })

  it('counts attached-document excerpts and short fetched pages as page text', () => {
    const m = msg([
      part('tool-documentRetrieval', 'doc-1', [
        { url: 'https://upload.local/doc', content: 'short excerpt' }
      ]),
      fetchPart('f1', [{ url: 'https://tiny.com', content: 'tiny page' }]),
      text('Doc. [1](#doc-1) Tiny. [1](#f1)')
    ])
    expect(auditCitationEvidence(m)).toMatchObject({
      page: 2,
      snippetRead: 0,
      snippet: 0
    })
  })

  it('is all zeros for a message with no citable calls or no anchors', () => {
    const zero = { page: 0, snippetRead: 0, snippet: 0, fetchedPagesUncited: 0 }
    expect(auditCitationEvidence(msg([text('No tools. [1](#x)')]))).toEqual(
      zero
    )
    expect(
      auditCitationEvidence(
        msg([search('s1', [{ url: 'https://a.com', content: SNIPPET }])])
      )
    ).toEqual(zero)
  })

  it('never resolves an anchor against another message', () => {
    // The page was read in an EARLIER turn; this message only has the snippet.
    const earlier = msg([
      fetchPart('f0', [{ url: 'https://a.com/x', content: PAGE }])
    ])
    const current = msg([
      search('s1', [{ url: 'https://a.com/x', content: SNIPPET }]),
      text('Fact. [1](#s1) Stale. [1](#f0)')
    ])
    expect(findPageTextForUrl('https://a.com/x', earlier)).toBeDefined()
    expect(auditCitationEvidence(current)).toEqual({
      page: 0,
      snippetRead: 0,
      snippet: 1,
      fetchedPagesUncited: 0
    })
  })
})
