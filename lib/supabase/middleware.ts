import { type NextRequest, NextResponse } from 'next/server'

import { createServerClient } from '@supabase/ssr'

import { getSupabasePublishableKey } from './keys'

// Paths an anonymous visitor may load. The pages/routes under these do their
// own checks (e.g. /search/[id] sends a private chat to /auth/login, /uploads
// verifies its capability URL, every /api route authorizes itself).
//
// '/' is matched EXACTLY. It used to sit in a `startsWith` list, where every
// pathname starts with '/', so the guard never redirected anything. Prefixes
// match on a segment boundary ('/auth' covers '/auth/login', not '/authx').
// The prefixes below are the routes that were reachable anonymously and are
// meant to be: the homepage + guest search, shared/public chats, auth pages,
// discover, library (its data comes from self-authorizing API/actions, so a
// signed-out visitor just sees an empty list), uploads (signed URLs) and the
// API. Anything else — including any route added later — now requires
// a session unless it is listed here.
const PUBLIC_EXACT = ['/']
const PUBLIC_PREFIXES = [
  '/auth',
  '/share',
  '/api',
  '/search',
  '/discover',
  '/library',
  '/uploads'
]

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true
  return PUBLIC_PREFIXES.some(
    prefix => pathname === prefix || pathname.startsWith(prefix + '/')
  )
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request
  })
  const supabaseKey = getSupabasePublishableKey()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    supabaseKey!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({
            request
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        }
      }
    }
  )

  // Do not run code between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  // IMPORTANT: DO NOT REMOVE auth.getUser()

  const {
    data: { user }
  } = await supabase.auth.getUser()

  // Redirect to login if the user is not authenticated and the path is not
  // public. ENABLE_AUTH=false (lab/anonymous mode) never redirects: every
  // request is the shared anonymous user there (see getCurrentUserId).
  if (
    !user &&
    process.env.ENABLE_AUTH !== 'false' &&
    !isPublicPath(request.nextUrl.pathname)
  ) {
    // no user, potentially respond by redirecting the user to the login page
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    return NextResponse.redirect(url)
  }

  // IMPORTANT: You *must* return the supabaseResponse object as it is.
  // If you're creating a new response object with NextResponse.next() make sure to:
  // 1. Pass the request in it, like so:
  //    const myNewResponse = NextResponse.next({ request })
  // 2. Copy over the cookies, like so:
  //    myNewResponse.cookies.setAll(supabaseResponse.cookies.getAll())
  // 3. Change the myNewResponse object to fit your needs, but avoid changing
  //    the cookies!
  // 4. Finally:
  //    return myNewResponse
  // If this is not done, you may be causing the browser and server to go out
  // of sync and terminate the user's session prematurely!

  return supabaseResponse
}
