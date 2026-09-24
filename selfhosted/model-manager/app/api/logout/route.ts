import { cookies } from 'next/headers'

import { SESSION_COOKIE, revokeSessionToken } from '@/lib/auth'

export async function POST() {
  // Revoke server-side first so the token is dead even if a copy survives the
  // cookie clear below.
  revokeSessionToken((await cookies()).get(SESSION_COOKIE)?.value)
  const res = Response.json({ ok: true })
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  )
  return res
}
