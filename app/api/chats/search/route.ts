import { NextRequest, NextResponse } from 'next/server'

import { searchChats } from '@/lib/actions/chat'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''

  if (!q) {
    return NextResponse.json({ results: [] })
  }

  try {
    const results = await searchChats(q)
    return NextResponse.json({ results })
  } catch (error) {
    console.error('Chat search error:', error)
    return NextResponse.json({ results: [] }, { status: 500 })
  }
}
