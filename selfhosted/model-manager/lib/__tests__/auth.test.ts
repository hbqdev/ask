import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SESSION_TTL_MS,
  isConfigured,
  makeSessionToken,
  revokeSessionToken,
  verifyPassword,
  verifySessionToken
} from '../auth'

type Env = Record<string, string | undefined>

let withPw: Env

beforeEach(() => {
  withPw = {
    MODEL_MANAGER_PASSWORD: 'hunter2',
    MODEL_MANAGER_SESSION_STORE: join(
      mkdtempSync(join(tmpdir(), 'mm-sess-')),
      's.json'
    )
  }
})

describe('auth', () => {
  it('fail-closed: unset password ⇒ not configured, no verify', () => {
    expect(isConfigured({} as Env)).toBe(false)
    expect(verifyPassword('anything', {} as Env)).toBe(false)
  })
  it('verifies the correct password only', () => {
    expect(verifyPassword('hunter2', withPw)).toBe(true)
    expect(verifyPassword('wrong', withPw)).toBe(false)
  })
  it('session token round-trips and rejects tampering', () => {
    const t = makeSessionToken(withPw)
    expect(verifySessionToken(t, withPw)).toBe(true)
    expect(verifySessionToken(t + 'x', withPw)).toBe(false)
    expect(verifySessionToken(undefined, withPw)).toBe(false)
  })
  it('token from one secret fails under another', () => {
    const t = makeSessionToken(withPw)
    expect(
      verifySessionToken(t, { ...withPw, MODEL_MANAGER_PASSWORD: 'other' })
    ).toBe(false)
  })
  it('every login yields a distinct token', () => {
    const a = makeSessionToken(withPw)
    const b = makeSessionToken(withPw)
    expect(a).not.toBe(b)
    expect(verifySessionToken(a, withPw)).toBe(true)
    expect(verifySessionToken(b, withPw)).toBe(true)
  })
  it('expires server-side after the TTL', () => {
    const t0 = 1_800_000_000_000
    const t = makeSessionToken(withPw, t0)
    expect(verifySessionToken(t, withPw, t0 + SESSION_TTL_MS - 1)).toBe(true)
    expect(verifySessionToken(t, withPw, t0 + SESSION_TTL_MS)).toBe(false)
  })
  it('logout revokes only that session', () => {
    const a = makeSessionToken(withPw)
    const b = makeSessionToken(withPw)
    revokeSessionToken(a, withPw)
    expect(verifySessionToken(a, withPw)).toBe(false)
    expect(verifySessionToken(b, withPw)).toBe(true)
  })
  it('a validly-signed token not in the session store is rejected', () => {
    const t = makeSessionToken(withPw)
    const fresh = {
      ...withPw,
      MODEL_MANAGER_SESSION_STORE: join(
        mkdtempSync(join(tmpdir(), 'mm-sess-')),
        's.json'
      )
    }
    // e.g. container recreated ⇒ store gone ⇒ everyone logs in again
    expect(verifySessionToken(t, fresh)).toBe(false)
  })
  it('the legacy constant token is no longer accepted', () => {
    expect(verifySessionToken('authenticated.deadbeef', withPw)).toBe(false)
  })
})
