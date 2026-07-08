import { generateText } from 'ai'
import { NextRequest, NextResponse } from 'next/server'

import { getModel } from '@/lib/utils/registry'

const SEARXNG_API_URL =
  process.env.SEARXNG_API_URL || 'https://search.hbqnexus.win'

async function rephraseForImageSearch(
  query: string,
  model: string
): Promise<string> {
  try {
    const { text } = await generateText({
      model: getModel(model),
      system:
        'You convert a user question into a concise image search query. Return only the search query, nothing else. No punctuation at the end.',
      prompt: query,
      maxOutputTokens: 30
    })
    return text.trim() || query
  } catch {
    return query
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const query: string = body.query || ''
  const model: string =
    body.model ||
    (process.env.OLLAMA_MODELS || '').split(',')[0]?.trim() ||
    'ollama:deepseek-v4-flash:cloud'

  if (!query) {
    return NextResponse.json({ error: 'query required' }, { status: 400 })
  }

  const searchQuery = model
    ? await rephraseForImageSearch(query, `ollama:${model}`)
    : query

  try {
    const url = new URL(`${SEARXNG_API_URL}/search`)
    url.searchParams.set('q', searchQuery)
    url.searchParams.set('format', 'json')
    url.searchParams.set('engines', 'bing images,google images')
    url.searchParams.set('categories', 'images')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' }
    })

    if (!res.ok) throw new Error('SearXNG request failed')
    const data = await res.json()

    const images = (data.results || [])
      .filter((r: any) => r.img_src)
      .slice(0, 12)
      .map((r: any) => ({
        img_src: r.img_src || '',
        url: r.url || r.img_src || '',
        title: r.title || ''
      }))

    return NextResponse.json({ images, query: searchQuery })
  } catch (err) {
    console.error('[images] SearXNG error:', err)
    return NextResponse.json({ images: [], query: searchQuery })
  }
}
