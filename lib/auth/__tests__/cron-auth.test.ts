import { afterEach, describe, expect, it } from 'vitest'

import { requireCronSecret } from '../cron-auth'

const req = (auth?: string) =>
  new Request('http://localhost/api/memory/recall-backfill', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {}
  })

afterEach(() => {
  delete process.env.MEMORY_CRON_SECRET
})

describe('requireCronSecret', () => {
  it('REFUSES when the secret is unconfigured, rather than running unguarded', async () => {
    // The regression this pins: the old per-route guard was
    // `if (secret && header !== bearer) return 401`, which fails OPEN — an
    // unset secret skipped the check and left a route that re-embeds every
    // user's history callable by anyone. It shipped to prod that way.
    delete process.env.MEMORY_CRON_SECRET
    const denied = requireCronSecret(req())
    expect(denied).not.toBeNull()
    expect(denied!.status).toBe(503)
  })

  it('refuses an unconfigured secret even when the caller sends a bearer', () => {
    delete process.env.MEMORY_CRON_SECRET
    const denied = requireCronSecret(req('Bearer anything'))
    expect(denied?.status).toBe(503)
  })

  it('rejects a missing authorization header', () => {
    process.env.MEMORY_CRON_SECRET = 's3cret'
    expect(requireCronSecret(req())?.status).toBe(401)
  })

  it('rejects a wrong secret', () => {
    process.env.MEMORY_CRON_SECRET = 's3cret'
    expect(requireCronSecret(req('Bearer wrong'))?.status).toBe(401)
  })

  it('rejects a bearer whose value is a prefix of the real secret', () => {
    process.env.MEMORY_CRON_SECRET = 's3cret'
    expect(requireCronSecret(req('Bearer s3c'))?.status).toBe(401)
  })

  it('rejects the raw secret without the Bearer scheme', () => {
    process.env.MEMORY_CRON_SECRET = 's3cret'
    expect(requireCronSecret(req('s3cret'))?.status).toBe(401)
  })

  it('allows the correct bearer token', () => {
    process.env.MEMORY_CRON_SECRET = 's3cret'
    expect(requireCronSecret(req('Bearer s3cret'))).toBeNull()
  })
})
