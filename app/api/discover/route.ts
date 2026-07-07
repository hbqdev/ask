import { NextRequest, NextResponse } from 'next/server'

const FRESHRSS_URL = process.env.FRESHRSS_URL || 'https://news.hbqnexus.win'
const FRESHRSS_USER = process.env.FRESHRSS_USER || ''
const FRESHRSS_PASS = process.env.FRESHRSS_PASS || ''

const CATEGORY_IDS: Record<string, string> = {
  tech: 'c_2',
  science: 'c_3',
  journalism: 'c_4',
  deals: 'c_5',
  youtube: 'c_6',
  random: 'c_8',
  sports: 'c_9',
  gaming: 'c_10',
  comics: 'c_12',
  casino: 'c_13',
}

// In-memory session cache
let _session: string | null = null
let _sessionExpiry = 0

async function getSession(): Promise<string> {
  if (_session && Date.now() < _sessionExpiry) return _session

  const res = await fetch(`${FRESHRSS_URL}/i/?c=auth&a=login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: FRESHRSS_USER, password: FRESHRSS_PASS }),
    redirect: 'manual',
  })

  const setCookie = res.headers.get('set-cookie') || ''
  const match = setCookie.match(/FreshRSS=([^;]+)/)
  if (!match) throw new Error('FreshRSS login failed')

  _session = `FreshRSS=${match[1]}`
  _sessionExpiry = Date.now() + 25 * 60 * 1000 // 25 min
  return _session
}

export interface DiscoverArticle {
  title: string
  url: string
  source: string
  excerpt: string
  image: string | null
  pubDate: string
}

function parseRSS(xml: string): DiscoverArticle[] {
  const items = xml.split('<item>').slice(1)
  return items
    .map(item => {
      const tag = (name: string) => {
        const m = item.match(
          new RegExp(`<${name}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${name}>`, 'i')
        )
        return m ? m[1].trim() : ''
      }

      const title = tag('title')
      const linkMatch = item.match(/<link>([^<]+)<\/link>/i)
      const url = linkMatch ? linkMatch[1].trim() : tag('link')
      // Prefer feed/publication name over author username
      let source = ''
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '')
        // Use registrable domain (second-level): tech.slashdot.org → slashdot
        const parts = hostname.split('.')
        const registrable = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
        // Capitalize nicely
        source = registrable
          .replace(/-/g, ' ')
          .split(' ')
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
        // Well-known overrides
        const overrides: Record<string, string> = {
          arstechnica: 'Ars Technica',
          reddit: 'Reddit',
          slashdot: 'Slashdot',
          techcrunch: 'TechCrunch',
          theverge: 'The Verge',
          thenextweb: 'The Next Web',
          wired: 'Wired',
          engadget: 'Engadget',
          gizmodo: 'Gizmodo',
          venturebeat: 'VentureBeat',
          theguardian: 'The Guardian',
          bbc: 'BBC',
          nytimes: 'NY Times',
          washingtonpost: 'Washington Post',
          theregister: 'The Register',
          '404media': '404 Media',
          phys: 'Phys.org',
          quantamagazine: 'Quanta',
        }
        if (overrides[registrable]) source = overrides[registrable]
      } catch {
        source = tag('dc:creator') || ''
      }
      const pubDate = tag('pubDate')

      const imageMatch = item.match(/<media:thumbnail[^>]+url="([^"]+)"/)
      const image = imageMatch ? imageMatch[1].replace(/&amp;/g, '&') : null

      const desc = tag('description')
      const excerpt = desc
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220)

      return { title, url, source, excerpt, image, pubDate }
    })
    .filter(a => a.title && a.url)
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const category = searchParams.get('category') || 'tech'
  const hours = searchParams.get('hours') || '48'

  const catId = CATEGORY_IDS[category]
  if (!catId) {
    return NextResponse.json({ error: 'Unknown category' }, { status: 400 })
  }

  try {
    const cookie = await getSession()
    const feedUrl = `${FRESHRSS_URL}/i/?a=rss&get=${catId}&ajax=1&hours=${hours}`

    const res = await fetch(feedUrl, {
      headers: { Cookie: cookie },
      next: { revalidate: 900 },
    })

    if (!res.ok) {
      _session = null // invalidate on failure
      return NextResponse.json({ articles: [] }, { status: 502 })
    }

    const xml = await res.text()
    const articles = parseRSS(xml)

    return NextResponse.json({ articles }, { headers: { 'Cache-Control': 's-maxage=900, stale-while-revalidate=60' } })
  } catch (err) {
    console.error('[discover]', err)
    _session = null
    return NextResponse.json({ articles: [] }, { status: 502 })
  }
}
