import {
  getCurrentUser,
  isBearerAuthorization
} from '@/lib/auth/get-current-user'

/**
 * Routes that answer a missing user with an empty 200 or a 204 (the guest
 * shape) call this first, so a native client whose bearer is invalid,
 * expired or revoked gets a 401 instead of a silently empty answer.
 *
 * Returns null, without any auth call, for a request that does not use the
 * Bearer scheme (the web's cookie path) and in anonymous mode; those keep
 * today's behaviour. A bearer request costs one extra Supabase getUser call.
 */
export async function rejectInvalidBearer(
  request: Request
): Promise<Response | null> {
  if (process.env.ENABLE_AUTH === 'false') return null
  if (!isBearerAuthorization(request.headers.get('authorization'))) return null

  const user = await getCurrentUser()
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}
