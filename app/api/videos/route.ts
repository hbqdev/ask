import { generateText } from 'ai'
import { NextRequest, NextResponse } from 'next/server'

import { getModel } from '@/lib/utils/registry'

const SEARXNG_API_URL =
  process.env.SEARXNG_API_URL || 'https://search.hbqnexus.win'

async function rephraseForVideoSearch(
  query: string,
  model: string
): Promise<string> {
  try {
    const { text } = await generateText({
      model: getModel(model),
      system:
        'You convert a user question into a concise YouTube video search query. Return only the search query, nothing else. No punctuation at the end.',
      prompt: query,
      maxOutputTokens: 30
    })
    return text.trim() || query
  } catch {
    return query
  }
}

async function fetchVideos(searchQuery: string) {
  const url = new URL(`${SEARXNG_API_URL}/search`)
  url.searchParams.set('q', searchQuery)
  url.searchParams.set('format', 'json')
  url.searchParams.set('engines', 'youtube')
  url.searchParams.set('categories', 'videos')

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    next: { revalidate: 3600 }
  })

  if (!res.ok) throw new Error('SearXNG request failed')
  const data = await res.json()

  return (data.results || [])
    .filter((r: any) => r.thumbnail || r.img_src)
    .slice(0, 8)
    .map((r: any) => ({
      title: r.title || '',
      url: r.url || '',
      thumbnail: r.thumbnail || r.img_src || '',
      engine: r.engine || 'youtube',
      publishedDate: r.publishedDate || null
    }))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q')

  if (!query) {
    return NextResponse.json({ error: 'q required' }, { status: 400 })
  }

  try {
    const videos = await fetchVideos(query)
    return NextResponse.json({ videos })
  } catch (err) {
    console.error('[videos] SearXNG error:', err)
    return NextResponse.json({ videos: [] })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const query: string = body.query || ''
  const model: string =
    body.model ||
    (process.env.OLLAMA_MODELS || '').split(',')[0]?.trim() ||
    ''

  if (!query) {
    return NextResponse.json({ error: 'query required' }, { status: 400 })
  }

  const searchQuery = model
    ? await rephraseForVideoSearch(query, `ollama:${model}`)
    : query

  try {
    const videos = await fetchVideos(searchQuery)
    return NextResponse.json({ videos, query: searchQuery })
  } catch (err) {
    console.error('[videos] SearXNG error:', err)
    return NextResponse.json({ videos: [], query: searchQuery })
  }
}
