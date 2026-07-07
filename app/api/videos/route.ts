import { NextRequest, NextResponse } from 'next/server'

const SEARXNG_API_URL =
  process.env.SEARXNG_API_URL || 'https://search.hbqnexus.win'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q')

  if (!query) {
    return NextResponse.json({ error: 'q required' }, { status: 400 })
  }

  try {
    const url = new URL(`${SEARXNG_API_URL}/search`)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('engines', 'youtube')
    url.searchParams.set('categories', 'videos')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 }
    })

    if (!res.ok) throw new Error('SearXNG request failed')
    const data = await res.json()

    // Filter and map video results
    const videos = (data.results || [])
      .filter((r: any) => r.thumbnail || r.img_src)
      .slice(0, 8)
      .map((r: any) => ({
        title: r.title || '',
        url: r.url || '',
        thumbnail: r.thumbnail || r.img_src || '',
        engine: r.engine || 'youtube',
        publishedDate: r.publishedDate || null
      }))

    return NextResponse.json({ videos })
  } catch (err) {
    console.error('[videos] SearXNG error:', err)
    return NextResponse.json({ videos: [] })
  }
}
