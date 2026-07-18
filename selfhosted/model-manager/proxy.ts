import { NextRequest, NextResponse } from 'next/server'
import { isConfigured, SESSION_COOKIE, verifySessionToken } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/api/login', '/api/health']

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }
  if (!isConfigured()) {
    return new NextResponse('Model manager is not configured (set MODEL_MANAGER_PASSWORD)', {
      status: 503
    })
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!verifySessionToken(token)) {
    if (pathname.startsWith('/api/')) return new NextResponse('Unauthorized', { status: 401 })
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
