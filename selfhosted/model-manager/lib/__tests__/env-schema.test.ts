import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, REGISTRY, specByKey } from '../env-schema'

const IGNORE = new Set<string>([
  // keys deliberately NOT managed by the UI (add here with justification)
])

describe('registry integrity', () => {
  it('has unique keys', () => {
    const keys = REGISTRY.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('every spec has a known category', () => {
    for (const s of REGISTRY) expect(CATEGORIES).toContain(s.category)
  })
  it('enum specs list their allowed values', () => {
    for (const s of REGISTRY.filter(s => s.type === 'enum')) {
      expect(s.enumValues && s.enumValues.length).toBeTruthy()
    }
  })
  it('validators return null for good input and a string for bad', () => {
    const url = specByKey('OLLAMA_BASE_URL')!
    expect(url.validate!('http://192.168.50.231:11434')).toBeNull()
    expect(typeof url.validate!('not-a-url')).toBe('string')
  })
})

describe('UPLOAD_TTL_DAYS', () => {
  const spec = specByKey('UPLOAD_TTL_DAYS')
  it('is registered as an optional integer in the storage category', () => {
    expect(spec).toBeDefined()
    expect(spec!.category).toBe('storage')
    expect(spec!.type).toBe('int')
    expect(spec!.required).toBeFalsy()
    expect(spec!.default).toBe('14')
  })
  it('validates as a non-negative integer (0 disables, negatives rejected)', () => {
    expect(spec!.validate!('14')).toBeNull()
    expect(spec!.validate!('0')).toBeNull()
    expect(typeof spec!.validate!('-1')).toBe('string')
    expect(typeof spec!.validate!('3.5')).toBe('string')
    expect(typeof spec!.validate!('abc')).toBe('string')
  })
})

describe('.env parity — every key in Ask .env has a spec', () => {
  it('covers all keys', () => {
    const sample = readFileSync(
      join(__dirname, 'fixtures/ask.env.sample'),
      'utf8'
    )
    const keys = sample
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0])
    const missing = keys.filter(k => !specByKey(k) && !IGNORE.has(k))
    expect(missing, `unmanaged keys: ${missing.join(', ')}`).toHaveLength(0)
  })
})
