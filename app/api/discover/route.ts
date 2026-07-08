const websitesForTopic = {
  tech: {
    query: ['technology news', 'latest tech', 'AI', 'science and innovation'],
    links: ['techcrunch.com', 'wired.com', 'theverge.com'],
  },
  finance: {
    query: ['finance news', 'economy', 'stock market', 'investing'],
    links: ['bloomberg.com', 'cnbc.com', 'marketwatch.com'],
  },
  art: {
    query: ['art news', 'culture', 'modern art', 'cultural events'],
    links: ['artnews.com', 'hyperallergic.com', 'theartnewspaper.com'],
  },
  sports: {
    query: ['sports news', 'latest sports', 'cricket football tennis'],
    links: ['espn.com', 'bbc.com/sport', 'skysports.com'],
  },
  entertainment: {
    query: ['entertainment news', 'movies', 'TV shows', 'celebrities'],
    links: ['hollywoodreporter.com', 'variety.com', 'deadline.com'],
  },
}

type Topic = keyof typeof websitesForTopic

async function searchSearxng(
  query: string,
  opts: { engines: string[]; pageno: number; language: string }
) {
  const apiUrl = process.env.SEARXNG_API_URL
  if (!apiUrl) return { results: [] }

  const url = new URL(`${apiUrl}/search?format=json`)
  url.searchParams.append('q', query)
  if (opts.engines) url.searchParams.append('engines', opts.engines.join(','))
  if (opts.pageno) url.searchParams.append('pageno', String(opts.pageno))
  if (opts.language) url.searchParams.append('language', opts.language)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(url.toString(), { signal: controller.signal })
    if (!res.ok) return { results: [] }
    const data = await res.json()
    return { results: data.results ?? [] }
  } catch {
    return { results: [] }
  } finally {
    clearTimeout(timeoutId)
  }
}

export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams
    const topic: Topic = (params.get('topic') as Topic) || 'tech'
    const isPreview = params.get('mode') === 'preview'
    const selectedTopic = websitesForTopic[topic] ?? websitesForTopic.tech

    // Preview mode: hit just one link + one query for speed (used by the home news widget)
    const links = isPreview ? [selectedTopic.links[0]] : selectedTopic.links
    const queries = isPreview ? [selectedTopic.query[0]] : selectedTopic.query

    const seenUrls = new Set<string>()

    const data = (
      await Promise.all(
        links.flatMap(link =>
          queries.map(async query => {
            return (
              await searchSearxng(`site:${link} ${query}`, {
                engines: ['bing news'],
                pageno: 1,
                language: 'en',
              })
            ).results
          })
        )
      )
    )
      .flat()
      .filter(item => {
        const url = item.url?.toLowerCase().trim()
        if (!url || seenUrls.has(url)) return false
        seenUrls.add(url)
        if (!item.title || item.title.trim().length < 20) return false
        return true
      })
      .sort(() => Math.random() - 0.5)
      .slice(0, isPreview ? 5 : 40)

    return Response.json({ blogs: data }, { status: 200 })
  } catch (err) {
    console.error(`An error occurred in discover route: ${err}`)
    return Response.json({ message: 'An error has occurred' }, { status: 500 })
  }
}
