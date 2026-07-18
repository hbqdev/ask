import { describe, expect, it } from 'vitest'
import {
  isConfigured,
  makeSessionToken,
  verifyPassword,
  verifySessionToken
} from '../auth'

type Env = Record<string, string | undefined>

const withPw = { MODEL_MANAGER_PASSWORD: 'hunter2' } as Env

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
      verifySessionToken(t, { MODEL_MANAGER_PASSWORD: 'other' } as Env)
    ).toBe(false)
  })
})
