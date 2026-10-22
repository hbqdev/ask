import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { fetchDiscoverPage, TOPICS } from '@/features/discover/discover-api'

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

function client(respond: () => Response) {
  const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
    respond()
  )
  const getToken = vi.fn(async () => null)
  return {
    fetchImpl,
    getToken,
    client: createApiClient({ baseUrl: BASE, getToken, fetchImpl })
  }
}

const blog = (over: Record<string, unknown> = {}) => ({
  title: 'A headline long enough to be kept',
  content: 'What happened, in two lines.',
  url: 'https://news.example/story',
  thumbnail: 'https://img.example/a.jpg',
  ...over
})

describe('TOPICS', () => {
  it("lists the web's topics, keys and labels, in the web's order", () => {
    expect(TOPICS).toEqual([
      { key: 'tech', label: 'Tech' },
      { key: 'science', label: 'Science' },
      { key: 'world', label: 'World' },
      { key: 'finance', label: 'Finance' },
      { key: 'art', label: 'Art & Culture' },
      { key: 'sports', label: 'Sports' },
      { key: 'gaming', label: 'Gaming' },
      { key: 'entertainment', label: 'Entertainment' },
      { key: 'health', label: 'Health' }
    ])
  })
})

describe('fetchDiscoverPage', () => {
  it('asks GET /api/discover for the topic and page, without a token', async () => {
    const { client: c, fetchImpl, getToken } = client(() => json({ blogs: [] }))
    await fetchDiscoverPage(c, 'science', 3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [input, init] = fetchImpl.mock.calls[0]
    const url = new URL(String(input))
    expect(url.origin + url.pathname).toBe(`${BASE}/api/discover`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      topic: 'science',
      page: '3'
    })
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET')
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    // Public route: the client never asks for a token (signed out works).
    expect(getToken).not.toHaveBeenCalled()
  })

  it('keeps only items with a thumbnail and an http(s) url', async () => {
    const { client: c } = client(() =>
      json({
        blogs: [
          blog({ url: 'https://ok.example/1' }),
          blog({ url: 'http://ok.example/2' }),
          blog({ url: 'https://no-thumb.example', thumbnail: '' }),
          blog({ url: 'javascript:alert(1)' }),
          blog({ url: 'data:text/html,hi' }),
          blog({ url: 'not a url' })
        ]
      })
    )
    const items = await fetchDiscoverPage(c, 'tech', 1)
    expect(items.map(i => i.url)).toEqual([
      'https://ok.example/1',
      'http://ok.example/2'
    ])
  })

  it('keeps only items whose thumbnail is http(s)', async () => {
    const { client: c } = client(() =>
      json({
        blogs: [
          blog({ url: 'https://ok.example/1' }),
          blog({ url: 'https://a.example', thumbnail: 'javascript:alert(1)' }),
          blog({ url: 'https://b.example', thumbnail: 'data:image/png,xx' }),
          blog({ url: 'https://c.example', thumbnail: '/relative.jpg' })
        ]
      })
    )
    const items = await fetchDiscoverPage(c, 'tech', 1)
    expect(items.map(i => i.url)).toEqual(['https://ok.example/1'])
  })

  it('maps content to summary, drops category and normalises the thumbnail', async () => {
    const { client: c } = client(() =>
      json({
        blogs: [
          blog({
            category: 'Tech',
            thumbnail:
              'https://www.bing.com/th?id=OVFT.abc&w=300&h=200&pid=News'
          }),
          blog({ url: 'https://news.example/2' })
        ]
      })
    )
    const items = await fetchDiscoverPage(c, 'tech', 1)
    expect(items).toEqual([
      {
        title: 'A headline long enough to be kept',
        summary: 'What happened, in two lines.',
        url: 'https://news.example/story',
        thumbnail: 'https://www.bing.com/th?id=OVFT.abc'
      },
      {
        title: 'A headline long enough to be kept',
        summary: 'What happened, in two lines.',
        url: 'https://news.example/2',
        thumbnail: 'https://img.example/a.jpg'
      }
    ])
  })

  it('rejects with an ApiError when the route fails', async () => {
    const { client: c } = client(() => json({ message: 'boom' }, 500))
    await expect(fetchDiscoverPage(c, 'tech', 1)).rejects.toBeInstanceOf(
      ApiError
    )
  })
})
