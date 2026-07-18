import { createHash, createHmac, timingSafeEqual } from 'crypto'

export const SESSION_COOKIE = 'mm_session'

type Env = Record<string, string | undefined>

export function isConfigured(env: Env = process.env): boolean {
  return !!env.MODEL_MANAGER_PASSWORD
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

export function verifyPassword(input: string, env: Env = process.env): boolean {
  const pw = env.MODEL_MANAGER_PASSWORD
  if (!pw) return false
  return timingSafeEqual(sha256(input), sha256(pw))
}

function secret(env: Env): string {
  return env.MODEL_MANAGER_SESSION_SECRET || `derived:${env.MODEL_MANAGER_PASSWORD}`
}

export function makeSessionToken(env: Env = process.env): string {
  const payload = 'authenticated'
  const sig = createHmac('sha256', secret(env)).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifySessionToken(token: string | undefined, env: Env = process.env): boolean {
  if (!token || !isConfigured(env)) return false
  const expected = makeSessionToken(env)
  const a = sha256(token)
  const b = sha256(expected)
  return timingSafeEqual(a, b)
}
