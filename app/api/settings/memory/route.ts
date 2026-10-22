import { NextRequest, NextResponse } from 'next/server'

import { getMemoryEnabled, setMemoryEnabledAction } from '@/lib/actions/memory'
import { getRecallEnabled, setRecallEnabledAction } from '@/lib/actions/recall'
import { getCurrentUserId } from '@/lib/auth/get-current-user'

const INVALID = { error: 'Invalid memory settings' }
const UPDATE_FAILED = 'Failed to update memory settings'

type MemorySettings = { memoryEnabled?: boolean; recallEnabled?: boolean }

// Each key is optional but must be a boolean when present, and at least one
// must be present.
function parseSettings(body: unknown): MemorySettings | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const { memoryEnabled, recallEnabled } = body as Record<string, unknown>
  const valid = (v: unknown) => v === undefined || typeof v === 'boolean'
  if (!valid(memoryEnabled) || !valid(recallEnabled)) return null
  if (memoryEnabled === undefined && recallEnabled === undefined) return null
  return {
    memoryEnabled: memoryEnabled as boolean | undefined,
    recallEnabled: recallEnabled as boolean | undefined
  }
}

function failed(error?: string) {
  return NextResponse.json(
    { error: error ?? UPDATE_FAILED, retryable: true },
    { status: 500 }
  )
}

// PUT /api/settings/memory {memoryEnabled?, recallEnabled?} → the native
// counterpart of the settings panel's toggles. Returns the stored values read
// back (an env kill switch can keep a toggle off).
export async function PUT(request: NextRequest) {
  try {
    if (!(await getCurrentUserId())) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const settings = parseSettings(await request.json().catch(() => null))
    if (!settings) return NextResponse.json(INVALID, { status: 400 })

    if (settings.memoryEnabled !== undefined) {
      const result = await setMemoryEnabledAction(settings.memoryEnabled)
      if (!result.success) return failed(result.error)
    }
    if (settings.recallEnabled !== undefined) {
      const result = await setRecallEnabledAction(settings.recallEnabled)
      if (!result.success) return failed(result.error)
    }

    const [enabled, recallEnabled] = await Promise.all([
      getMemoryEnabled(),
      getRecallEnabled()
    ])
    return NextResponse.json({ ok: true, enabled, recallEnabled })
  } catch (error) {
    console.error('PUT /api/settings/memory failed:', error)
    return failed()
  }
}
