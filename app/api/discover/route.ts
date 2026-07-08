import { NextRequest, NextResponse } from 'next/server'

const TOPICS: Record<string, { queries: string[]; sites: string[] }> = {
  tech: {
    queries: ['technology news', 'latest tech', 'AI news', 'science and innovation'],
    sites: ['techcrunch.com', 'wired.com', 'theverge.com'],
  },
  finance: {
    queries: ['finance news', 'economy', 'stock market', 'investing'],
    sites: ['bloomberg.com', 'cnbc.com', 'marketwatch.com'],
  },
  art: {
    queries: ['art news', 'culture', 'modern art', 'cultural events'],
    sites: ['artnews.com', 'hyperallergic.com', 'theartnewspaper.com'],
  },
  sports: {
    queries: ['sports news', 'latest sports', 'football basketball tennis'],
    sites: ['espn.com', 'bbc.com/sport', 'skysports.com'],
  },
  entertainment: {
    queries: ['entertainment news', 'movies', 'TV shows'],
    sites: ['hollywoodreporter.com', 'variety.com', 'deadline.com'],
  },
}

export interface DiscoverArticle {
  title: string
  url: string
  content: string
  thumbnail: string
}

type Topic = keyof typeof TOPICS

async function searchSearxng(
  query: string,
  apiUrl: string
): Promise<DiscoverArticle[]> {
  const url = new URL(`${apiUrl}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('engines', 'bing news')
  url.searchParams.set('pageno', '1')
  url.searchParams.set('language', 'en')

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    next: { revalidate: 900 },
  })

  if (!res.ok) return []

  const data = await res.json()
  return (data.results ?? [])
    .filter((r: { thumbnail?: string }) => r.thumbnail)
    .map((r: { title: string; url: string; content?: string; thumbnail: string }) => ({
      title: r.title,
      url: r.url,
      content: r.content ?? '',
      thumbnail: r.thumbnail,
    }))
}

export async function GET(request: NextRequest) {
  const apiUrl = process.env.SEARXNG_API_URL
  if (!apiUrl) {
    return NextResponse.json({ articles: [] }, { status: 503 })
  }

  const topic = (request.nextUrl.searchParams.get('topic') ?? 'tech') as Topic
  const config = TOPICS[topic] ?? TOPICS.tech

  try {
    const seen = new Set<string>()

    const results = await Promise.all(
      config.sites.flatMap(site =>
        config.queries.map(query => searchSearxng(`site:${site} ${query}`, apiUrl))
      )
    )

    const articles = results
      .flat()
      .filter(item => {
        if (!item.title || !item.url || seen.has(item.url)) return false
        seen.add(item.url)
        return true
      })
      .sort(() => Math.random() - 0.5)
      .slice(0, 16)

    return NextResponse.json(
      { articles },
      { headers: { 'Cache-Control': 's-maxage=900, stale-while-revalidate=60' } }
    )
  } catch (err) {
    console.error('[discover]', err)
    return NextResponse.json({ articles: [] }, { status: 500 })
  }
}
