import { resolveDegoogUrl } from '@/lib/tools/search/providers/merge-degoog'
import type { DegoogResponse } from '@/lib/types'
import { fetchDegoogJson } from '@/lib/utils/degoog-client'

const websitesForTopic = {
  tech: {
    query: ['technology news', 'latest tech', 'AI', 'startups'],
    links: [
      'techcrunch.com',
      'wired.com',
      'theverge.com',
      'arstechnica.com',
      'engadget.com',
      'cnet.com',
      'gizmodo.com',
      'techradar.com',
      'zdnet.com',
      'venturebeat.com'
    ]
  },
  science: {
    query: [
      'science news',
      'scientific discovery',
      'space exploration',
      'research breakthrough'
    ],
    links: [
      'sciencedaily.com',
      'nature.com',
      'space.com',
      'scientificamerican.com',
      'livescience.com',
      'newscientist.com',
      'phys.org',
      'sciencenews.org',
      'nationalgeographic.com',
      'popsci.com'
    ]
  },
  finance: {
    query: ['finance news', 'economy', 'stock market', 'investing'],
    links: [
      'bloomberg.com',
      'cnbc.com',
      'marketwatch.com',
      'wsj.com',
      'ft.com',
      'forbes.com',
      'businessinsider.com',
      'investing.com',
      'fortune.com',
      'reuters.com/business'
    ]
  },
  art: {
    query: ['art news', 'culture', 'modern art', 'cultural events'],
    links: [
      'artnews.com',
      'hyperallergic.com',
      'theartnewspaper.com',
      'artforum.com',
      'frieze.com',
      'smithsonianmag.com',
      'artsy.net',
      'colossal.com',
      'artnet.com',
      'apollo-magazine.com'
    ]
  },
  sports: {
    query: ['sports news', 'latest sports', 'cricket football tennis'],
    links: [
      'espn.com',
      'bbc.com/sport',
      'skysports.com',
      'cbssports.com',
      'si.com',
      'foxsports.com',
      'nbcsports.com',
      'sportingnews.com',
      'bleacherreport.com',
      'theathletic.com'
    ]
  },
  entertainment: {
    query: ['entertainment news', 'movies', 'TV shows', 'celebrities'],
    links: [
      'hollywoodreporter.com',
      'variety.com',
      'deadline.com',
      'ew.com',
      'people.com',
      'eonline.com',
      'tmz.com',
      'rollingstone.com',
      'indiewire.com',
      'vulture.com'
    ]
  },
  world: {
    query: [
      'world news',
      'international affairs',
      'politics',
      'global politics'
    ],
    links: [
      'reuters.com',
      'apnews.com',
      'bbc.com/news',
      'aljazeera.com',
      'theguardian.com/world',
      'npr.org',
      'politico.com',
      'axios.com',
      'foreignpolicy.com',
      'thehill.com'
    ]
  },
  gaming: {
    query: [
      'video game news',
      'gaming industry',
      'new game releases',
      'esports'
    ],
    links: [
      'ign.com',
      'polygon.com',
      'kotaku.com',
      'gamespot.com',
      'pcgamer.com',
      'eurogamer.net',
      'rockpapershotgun.com',
      'destructoid.com',
      'gameinformer.com',
      'thegamer.com'
    ]
  },
  health: {
    query: ['health news', 'medical research', 'public health', 'wellness'],
    links: [
      'statnews.com',
      'medicalnewstoday.com',
      'webmd.com',
      'healthline.com',
      'medscape.com',
      'health.com',
      'everydayhealth.com',
      'self.com',
      'verywellhealth.com',
      'medpagetoday.com'
    ]
  }
}

type Topic = keyof typeof websitesForTopic

// Each topic now has 10 sites, but a single page still only queries a
// rotating handful of them — crossing all 10 with every query on every
// request would multiply the fan-out to SearXNG/degoog (and the real
// engines behind them) several times over versus the original 3-site
// topics, re-risking the rate-limiting these engines already have. Instead,
// pagination itself cycles through the full site list a few at a time, so
// scrolling further both surfaces fresh pages AND new sites.
const LINKS_PER_PAGE = 3

function linksForPage(allLinks: string[], page: number): string[] {
  const count = Math.min(LINKS_PER_PAGE, allLinks.length)
  const start = ((page - 1) * LINKS_PER_PAGE) % allLinks.length
  return Array.from(
    { length: count },
    (_, i) => allLinks[(start + i) % allLinks.length]
  )
}

interface DiscoverItem {
  title: string
  content: string
  url: string
  thumbnail: string
}

async function searchSearxng(
  query: string,
  opts: { engines: string[]; pageno: number; language: string }
): Promise<{ results: DiscoverItem[] }> {
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

// degoog is a complement to SearXNG here too (see
// lib/tools/search/providers/searxng.ts for the same pattern applied to the
// main search flow): its `news` engines (Bing News, Brave News, DuckDuckGo
// News, ...) add more sources than SearXNG's single hardcoded `bing news`
// engine, so the same query surfaces more distinct articles.
async function searchDegoogNews(
  query: string,
  page: number
): Promise<DiscoverItem[]> {
  const baseUrl = process.env.DEGOOG_API_URL
  if (!baseUrl) return []

  try {
    const result = await fetchDegoogJson(base => {
      const url = new URL(`${base}/api/search`)
      url.searchParams.append('q', query)
      url.searchParams.append('type', 'news')
      url.searchParams.append('page', String(page))
      return url.toString()
    })
    if (!result) return []

    const data = result.data as DegoogResponse
    return (data.results ?? []).map(item => ({
      title: item.title,
      content: item.snippet,
      url: item.url,
      thumbnail: resolveDegoogUrl(item.thumbnail ?? '', baseUrl)
    }))
  } catch (err) {
    console.warn(
      '[degoog] discover news search failed, continuing without it:',
      err
    )
    return []
  }
}

export const GET = async (req: Request) => {
  try {
    const params = new URL(req.url).searchParams
    const topic: Topic = (params.get('topic') as Topic) || 'tech'
    const isPreview = params.get('mode') === 'preview'
    const page = Math.max(1, Number(params.get('page')) || 1)
    const selectedTopic = websitesForTopic[topic] ?? websitesForTopic.tech

    // Preview mode: hit just one link + one query for speed (used by the home news widget)
    const links = isPreview
      ? [selectedTopic.links[0]]
      : linksForPage(selectedTopic.links, page)
    const queries = isPreview ? [selectedTopic.query[0]] : selectedTopic.query

    const seenUrls = new Set<string>()

    const linkQueryPairs = links.flatMap(link =>
      queries.map(query => `site:${link} ${query}`)
    )

    const [searxngResults, degoogResults] = await Promise.all([
      Promise.all(
        linkQueryPairs.map(async q => {
          return (
            await searchSearxng(q, {
              engines: ['bing news'],
              pageno: page,
              language: 'en'
            })
          ).results
        })
      ).then(r => r.flat()),
      Promise.all(linkQueryPairs.map(q => searchDegoogNews(q, page))).then(r =>
        r.flat()
      )
    ])

    const data = [...searxngResults, ...degoogResults]
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
