import { afterEach, describe, expect, it } from 'vitest'

import { uploadTtlDays } from '../upload-ttl'

const prev = process.env.UPLOAD_TTL_DAYS
afterEach(() => {
  if (prev === undefined) delete process.env.UPLOAD_TTL_DAYS
  else process.env.UPLOAD_TTL_DAYS = prev
})

describe('uploadTtlDays', () => {
  it('defaults to 0 (expiry disabled) when unset', () => {
    delete process.env.UPLOAD_TTL_DAYS
    expect(uploadTtlDays()).toBe(0)
  })

  it.each([
    ['0', 0],
    ['-3', 0],
    ['abc', 0],
    ['', 0],
    ['14', 14],
    ['7.9', 7]
  ])('parses %j as %d', (raw, want) => {
    process.env.UPLOAD_TTL_DAYS = raw
    expect(uploadTtlDays()).toBe(want)
  })
})
