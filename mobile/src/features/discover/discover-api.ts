// Discover's call to Ask's public news route (app/api/discover/route.ts): one
// page of articles for a topic, kept only when it can be shown (an http(s)
// thumbnail) and opened (an http(s) url), as the web's Discover page does.

import type { ApiClient } from '@/core/api/client'
import { thumbUrl } from '@/lib/discover/thumb-url'
import { sanitizeHttpUrl } from '@/lib/utils/safe-url'

export type Topic =
  | 'tech'
  | 'science'
  | 'finance'
  | 'art'
  | 'sports'
  | 'entertainment'
  | 'world'
  | 'gaming'
  | 'health'

/**
 * The web's Discover topics (app/discover/page.tsx), same keys, labels and
 * order. That list lives inside the web page component, so it is restated
 * here rather than imported.
 */
export const TOPICS: { key: Topic; label: string }[] = [
  { key: 'tech', label: 'Tech' },
  { key: 'science', label: 'Science' },
  { key: 'world', label: 'World' },
  { key: 'finance', label: 'Finance' },
  { key: 'art', label: 'Art & Culture' },
  { key: 'sports', label: 'Sports' },
  { key: 'gaming', label: 'Gaming' },
  { key: 'entertainment', label: 'Entertainment' },
  { key: 'health', label: 'Health' }
]

export type DiscoverItem = {
  title: string
  summary: string
  url: string
  thumbnail: string
}

/** GET /api/discover as the server sends it. */
type DiscoverResponse = {
  blogs: Array<{
    title: string
    content: string
    url: string
    thumbnail: string
    category?: string
  }>
}

/**
 * One page (1..DISCOVER_MAX_PAGE, see useDiscover) of a topic's articles. The route is public, so no token is
 * asked for or sent: this works signed out.
 */
export async function fetchDiscoverPage(
  client: ApiClient,
  topic: Topic,
  page: number
): Promise<DiscoverItem[]> {
  const params = new URLSearchParams({ topic, page: String(page) })
  const { blogs } = await client.json<DiscoverResponse>(
    `/api/discover?${params}`,
    { auth: false }
  )
  return blogs
    .filter(
      blog => sanitizeHttpUrl(blog.thumbnail) && sanitizeHttpUrl(blog.url)
    )
    .map(blog => ({
      title: blog.title,
      summary: blog.content,
      url: blog.url,
      thumbnail: thumbUrl(blog.thumbnail)
    }))
}
