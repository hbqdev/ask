import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync, renameSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const SESSION_COOKIE = 'mm_session'

// Server-side session lifetime. The cookie Max-Age mirrors it, but the server
// enforces it independently (a replayed/kept cookie past this is rejected).
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000

type Env = Record<string, string | undefined>

export function isConfigured(env: Env = process.env): boolean {
  return !!env.MODEL_MANAGER_PASSWORD
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

export function verifyPassword(input: string, env: Env = process.env): boolean {
  const pw = env.MODEL_MANAGER_PASSWORD
  if (!pw) return false
  return safeEqual(input, pw)
}

function secret(env: Env): string {
  return (
    env.MODEL_MANAGER_SESSION_SECRET || `derived:${env.MODEL_MANAGER_PASSWORD}`
  )
}

function sign(payload: string, env: Env): string {
  return createHmac('sha256', secret(env)).update(payload).digest('hex')
}

// ── Session store ────────────────────────────────────────────────────────────
// Active sessions are an allowlist of random ids → expiry, kept in a small JSON
// file. A file (not a module-level Map) because Next's proxy is bundled apart
// from the route handlers and must not rely on shared module state; both run
// in the same container, so they share the filesystem. Default lives in the
// container's /tmp, so recreating the container logs everyone out (fail-closed).
type Store = Record<string, number>

function storePath(env: Env): string {
  return (
    env.MODEL_MANAGER_SESSION_STORE ||
    join(tmpdir(), 'model-manager-sessions.json')
  )
}

function readStore(env: Env): Store {
  try {
    const parsed = JSON.parse(readFileSync(storePath(env), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Store
    }
  } catch {
    // missing/corrupt ⇒ no sessions (fail-closed)
  }
  return {}
}

function writeStore(store: Store, env: Env): void {
  const p = storePath(env)
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 })
  renameSync(tmp, p)
}

function pruned(store: Store, now: number): Store {
  const out: Store = {}
  for (const [id, exp] of Object.entries(store)) {
    if (typeof exp === 'number' && exp > now) out[id] = exp
  }
  return out
}

// Token: `<id>.<issuedAtMs>.<hmac(id.issuedAt)>`. The id is random per login,
// so every login yields a distinct token; the HMAC binds it to the current
// secret (changing the password invalidates every session); the store makes
// expiry + logout enforceable server-side.
export function makeSessionToken(
  env: Env = process.env,
  now: number = Date.now()
): string {
  const id = randomBytes(24).toString('hex')
  const payload = `${id}.${now}`
  const store = pruned(readStore(env), now)
  store[id] = now + SESSION_TTL_MS
  writeStore(store, env)
  return `${payload}.${sign(payload, env)}`
}

function parseToken(
  token: string,
  env: Env
): { id: string; iat: number } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [id, iatRaw, sig] = parts
  if (!/^[0-9a-f]{48}$/.test(id) || !/^\d{1,16}$/.test(iatRaw)) return null
  if (!safeEqual(sig, sign(`${id}.${iatRaw}`, env))) return null
  return { id, iat: Number(iatRaw) }
}

export function verifySessionToken(
  token: string | undefined,
  env: Env = process.env,
  now: number = Date.now()
): boolean {
  if (!token || !isConfigured(env)) return false
  const parsed = parseToken(token, env)
  if (!parsed) return false
  if (parsed.iat > now + 60_000 || now - parsed.iat >= SESSION_TTL_MS) {
    return false
  }
  const exp = readStore(env)[parsed.id]
  return typeof exp === 'number' && exp > now
}

// Logout: drop the session from the allowlist so the cookie value is dead even
// if it was copied before the browser cleared it.
export function revokeSessionToken(
  token: string | undefined,
  env: Env = process.env,
  now: number = Date.now()
): void {
  if (!token) return
  const parsed = parseToken(token, env)
  if (!parsed) return
  const store = pruned(readStore(env), now)
  if (!(parsed.id in store)) return
  delete store[parsed.id]
  writeStore(store, env)
}
