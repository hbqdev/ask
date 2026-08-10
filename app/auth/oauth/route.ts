import { NextResponse } from 'next/server'

// The client you created from the Server-Side Auth instructions
import { createClient } from '@/lib/supabase/server'
import { safeRelativePath } from '@/lib/utils/safe-redirect'
import { getBaseUrl } from '@/lib/utils/url'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  // Validated to a same-origin relative path (open-redirect / login-fixation).
  const next = safeRelativePath(searchParams.get('next'))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Build the redirect from the CONFIGURED canonical base (BASE_URL), not the
      // client-controllable x-forwarded-host header the previous code trusted, so
      // the redirect host cannot be attacker-retargeted. `next` is already a safe
      // relative path resolved against that base.
      const base = await getBaseUrl()
      return NextResponse.redirect(new URL(next, base))
    }
  }

  const base = await getBaseUrl()
  return NextResponse.redirect(new URL('/auth/error', base))
}
