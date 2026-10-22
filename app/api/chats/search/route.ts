import { NextRequest, NextResponse } from 'next/server'

import { searchChats } from '@/lib/actions/chat'
import { rejectInvalidBearer } from '@/lib/auth/reject-invalid-bearer'

export async function GET(request: NextRequest) {
  const rejected = await rejectInvalidBearer(request)
  if (rejected) return rejected

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  // Semantic recall is opt-in (explicit submit). Default = keyword-only, so
  // the debounced as-you-type path never pays the embedder/reranker round-trip.
  const includeSemantic = searchParams.get('semantic') === '1'

  if (!q) {
    return NextResponse.json({ results: [] })
  }

  try {
    const results = await searchChats(q, includeSemantic)
    return NextResponse.json({ results })
  } catch (error) {
    console.error('Chat search error:', error)
    return NextResponse.json({ results: [] }, { status: 500 })
  }
}
