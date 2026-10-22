import { NextResponse } from 'next/server'

import {
  clearRecallIndexAction,
  rebuildRecallIndexAction
} from '@/lib/actions/recall'

import { memoryErrorResponse } from '../memory-response'

// POST /api/memory/recall → index ONE bounded batch → {messages, chunks, done}.
// The client loops until done, and must stop on a round with messages > 0 and
// chunks === 0 (no progress; see rebuildRecallIndexAction).
export async function POST() {
  let result: Awaited<ReturnType<typeof rebuildRecallIndexAction>>
  try {
    result = await rebuildRecallIndexAction()
  } catch (error) {
    console.error('POST /api/memory/recall failed:', error)
    return memoryErrorResponse(undefined, 'Failed to rebuild recall index')
  }
  if (!result.success) {
    return memoryErrorResponse(result.error, 'Failed to rebuild recall index')
  }
  const { messages, chunks, done } = result
  return NextResponse.json({ messages, chunks, done })
}

// DELETE /api/memory/recall → delete every indexed chunk → {ok:true}.
export async function DELETE() {
  let result: Awaited<ReturnType<typeof clearRecallIndexAction>>
  try {
    result = await clearRecallIndexAction()
  } catch (error) {
    console.error('DELETE /api/memory/recall failed:', error)
    return memoryErrorResponse(undefined, 'Failed to clear recall index')
  }
  if (!result.success) {
    return memoryErrorResponse(result.error, 'Failed to clear recall index')
  }
  return NextResponse.json({ ok: true })
}
