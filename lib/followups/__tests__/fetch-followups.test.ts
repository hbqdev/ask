import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchFollowups } from '../fetch-followups'

const req = { question: 'q', answer: 'a' }

function mockFetch(impl: () => Promise<unknown>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchFollowups', () => {
  it('POSTs JSON to /api/chat/followups and returns the questions', async () => {
    const fn = mockFetch(
      async () =>
        new Response(JSON.stringify({ questions: ['a?', 'b?'] }), {
          status: 200
        })
    )
    const signal = new AbortController().signal
    await expect(fetchFollowups(req, signal)).resolves.toEqual(['a?', 'b?'])
    expect(fn).toHaveBeenCalledWith('/api/chat/followups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal
    })
  })

  it.each([400, 401, 404, 500])('returns [] on HTTP %i', async status => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ questions: ['x?'] }), { status })
    )
    await expect(fetchFollowups(req)).resolves.toEqual([])
  })

  it('returns [] on a network error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchFollowups(req)).resolves.toEqual([])
  })

  it('returns [] on bad JSON', async () => {
    mockFetch(async () => new Response('not json', { status: 200 }))
    await expect(fetchFollowups(req)).resolves.toEqual([])
  })

  it('returns [] when questions is not a string array', async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ questions: 'nope' }), { status: 200 })
    )
    await expect(fetchFollowups(req)).resolves.toEqual([])
    mockFetch(
      async () =>
        new Response(JSON.stringify({ questions: ['ok?', 3] }), { status: 200 })
    )
    await expect(fetchFollowups(req)).resolves.toEqual(['ok?'])
  })
})
