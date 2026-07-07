import type { SearchMode } from '@/lib/types/search'

export const ADAPTIVE_MODE_AUTH_REQUIRED_MESSAGE =
  'Sign in to use Balanced or Quality mode. Speed mode remains available without an account.'

export function requiresAdaptiveModeAuth({
  isGuest,
  isCloudDeployment
}: {
  isGuest?: boolean
  isCloudDeployment?: boolean
}) {
  return Boolean(isGuest && isCloudDeployment)
}

export function isAdaptiveModeAuthBlocked({
  mode,
  isGuest,
  isCloudDeployment
}: {
  mode: SearchMode
  isGuest?: boolean
  isCloudDeployment?: boolean
}) {
  return (
    (mode === 'balanced' || mode === 'quality') &&
    requiresAdaptiveModeAuth({ isGuest, isCloudDeployment })
  )
}
