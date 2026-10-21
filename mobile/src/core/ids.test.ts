import { describe, expect, it } from 'vitest'

import { newId } from './ids'

// Chat and message ids are generated client-side as cuid2, exactly as the web.
describe('newId', () => {
  it('returns a cuid2 string', () => {
    expect(newId()).toMatch(/^[a-z0-9]{20,32}$/)
  })

  it('returns a different id on every call', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()))
    expect(ids.size).toBe(1000)
  })
})
