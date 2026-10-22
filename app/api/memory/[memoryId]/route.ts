import { NextRequest, NextResponse } from 'next/server'

import { deleteMemoryAction } from '@/lib/actions/memory'

import { memoryErrorResponse } from '../memory-response'

type Context = { params: Promise<{ memoryId: string }> }

// DELETE /api/memory/{id} → {ok:true}. A missing or foreign memory is 404.
export async function DELETE(_request: NextRequest, { params }: Context) {
  const { memoryId } = await params
  let result: Awaited<ReturnType<typeof deleteMemoryAction>>
  try {
    result = await deleteMemoryAction(memoryId)
  } catch (error) {
    console.error('DELETE /api/memory/[memoryId] failed:', error)
    return memoryErrorResponse(undefined, 'Failed to delete memory')
  }
  if (!result.success) {
    return memoryErrorResponse(result.error, 'Failed to delete memory')
  }
  if (!result.deleted) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
