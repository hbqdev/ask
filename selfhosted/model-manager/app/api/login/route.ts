import { SESSION_COOKIE, makeSessionToken, verifyPassword } from '@/lib/auth'

export async function POST(req: Request) {
  const { password } = (await req.json()) as { password?: string }
  if (!password || !verifyPassword(password)) {
    return new Response('Invalid', { status: 401 })
  }
  const res = Response.json({ ok: true })
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${makeSessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
  )
  return res
}
