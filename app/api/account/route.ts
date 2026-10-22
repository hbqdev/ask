import { NextRequest, NextResponse } from 'next/server'

import { deleteAccount } from '@/lib/actions/account'

// deleteAccount's refusals, mapped to statuses.
const ANONYMOUS_MODE = 'Account deletion is unavailable in anonymous mode.'
const SIGNED_OUT = 'User not authenticated'
const NOT_CONFIGURED =
  'Account deletion is not configured. Set SUPABASE_SECRET_KEY.'

// What a failure tells the client: fixed text only. deleteAccount's own
// message can be upstream (Supabase or R2) text, so it is logged here instead.
const FAILED = { error: 'Failed to delete account', retryable: true }
// A retry cannot help until the operator sets the admin key.
const UNAVAILABLE = {
  error: 'Account deletion is not configured on this server.',
  retryable: false
}

const CONFIRM_REQUIRED = {
  error: 'Send {"confirm":"DELETE"} to delete the account.'
}

// Deletion is irreversible, so the body must be exactly {"confirm":"DELETE"}.
async function isConfirmed(request: NextRequest): Promise<boolean> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return false
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const keys = Object.keys(body)
  return (
    keys.length === 1 &&
    keys[0] === 'confirm' &&
    (body as { confirm: unknown }).confirm === 'DELETE'
  )
}

// DELETE /api/account {confirm:'DELETE'} → delete the signed-in user's data
// and auth user → {ok:true}. The client then signs out locally (its refresh
// token is already dead). On a failure the auth user is kept, so the user
// stays signed in and can retry.
export async function DELETE(request: NextRequest) {
  if (!(await isConfirmed(request))) {
    return NextResponse.json(CONFIRM_REQUIRED, { status: 400 })
  }

  let result: Awaited<ReturnType<typeof deleteAccount>>
  try {
    result = await deleteAccount()
  } catch (error) {
    console.error('DELETE /api/account failed:', error)
    result = { success: false }
  }
  if (result.success) return NextResponse.json({ ok: true })

  if (result.error === ANONYMOUS_MODE) {
    return NextResponse.json({ error: result.error }, { status: 409 })
  }
  if (result.error === SIGNED_OUT) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (result.error) console.error('DELETE /api/account failed:', result.error)
  return NextResponse.json(
    result.error === NOT_CONFIGURED ? UNAVAILABLE : FAILED,
    { status: 500 }
  )
}
