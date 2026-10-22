import { NextResponse } from 'next/server'

import {
  clearMemoriesAction,
  getMemories,
  getMemoryEnabled
} from '@/lib/actions/memory'
import { getRecallEnabled, getRecallStatus } from '@/lib/actions/recall'
import { getCurrentUserId } from '@/lib/auth/get-current-user'

import {
  memoryErrorResponse,
  toMemoryJson,
  unauthorized
} from './memory-response'

// GET /api/memory → the memory and recall toggles, the recall index status and
// the user's memories (no embeddings). The actions return defaults for guests,
// so the user is checked first to answer 401 instead.
export async function GET() {
  try {
    if (!(await getCurrentUserId())) return unauthorized()
    const [enabled, recallEnabled, recall, memories] = await Promise.all([
      getMemoryEnabled(),
      getRecallEnabled(),
      getRecallStatus(),
      getMemories()
    ])
    return NextResponse.json({
      enabled,
      recallEnabled,
      recall,
      memories: memories.map(toMemoryJson)
    })
  } catch (error) {
    console.error('GET /api/memory failed:', error)
    return memoryErrorResponse(undefined, 'Failed to load memory')
  }
}

// DELETE /api/memory → clear every memory → {ok:true}.
export async function DELETE() {
  let result: Awaited<ReturnType<typeof clearMemoriesAction>>
  try {
    result = await clearMemoriesAction()
  } catch (error) {
    console.error('DELETE /api/memory failed:', error)
    return memoryErrorResponse(undefined, 'Failed to clear memories')
  }
  if (!result.success) {
    return memoryErrorResponse(result.error, 'Failed to clear memories')
  }
  return NextResponse.json({ ok: true })
}
