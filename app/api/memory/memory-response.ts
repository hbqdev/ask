import { NextResponse } from 'next/server'

import type { MemoryListItem } from '@/lib/db/schema'

// Shared by the memory routes: native-client wrappers around the
// self-resolving actions in lib/actions/memory.ts and recall.ts.

// The memory as the API exposes it: no owner id, no embedding.
export function toMemoryJson(memory: MemoryListItem) {
  return {
    id: memory.id,
    content: memory.content,
    category: memory.category,
    status: memory.status,
    updatedAt: memory.updatedAt,
    lastUsedAt: memory.lastUsedAt
  }
}

// The actions' no-user refusal.
const SIGNED_OUT = 'User not authenticated'

export function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// An action's failure: no user → 401; anything else is a retryable 500.
export function memoryErrorResponse(
  error: string | undefined,
  fallback: string
) {
  if (error === SIGNED_OUT) return unauthorized()
  return NextResponse.json(
    { error: error ?? fallback, retryable: true },
    { status: 500 }
  )
}
