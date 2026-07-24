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

describe('Replicate image-generation env', () => {
  it('REPLICATE_API_TOKEN is an optional secret in the models category', () => {
    const spec = specByKey('REPLICATE_API_TOKEN')
    expect(spec).toBeDefined()
    expect(spec!.category).toBe('models')
    expect(spec!.type).toBe('secret')
    expect(spec!.required).toBeFalsy()
  })
  it('REPLICATE_IMAGE_MODEL is a pin-override enum of generate-capable models with no default (unset = rotate)', () => {
    const spec = specByKey('REPLICATE_IMAGE_MODEL')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.default).toBeUndefined()
    expect(spec!.enumValues).toEqual([
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'google/imagen-4',
      'google/imagen-4-fast',
      'google/imagen-4-ultra',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image',
      'prunaai/z-image-turbo',
      'prunaai/z-image',
      'prunaai/ernie-image-turbo',
      'recraft-ai/recraft-v4.1',
      'recraft-ai/recraft-v4.1-pro',
      'recraft-ai/recraft-v4.1-utility',
      'recraft-ai/recraft-v4.1-svg',
      'bria/image-3.2',
      'bria/fibo'
    ])
  })
  it('REPLICATE_IMAGE_EDIT_MODEL is a pin-override enum of edit-capable models with no default (unset = rotate)', () => {
    const spec = specByKey('REPLICATE_IMAGE_EDIT_MODEL')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.default).toBeUndefined()
    expect(spec!.enumValues).toEqual([
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image-edit',
      'bria/fibo-edit'
    ])
  })
  it('REPLICATE_MONTHLY_BUDGET validates as a non-negative integer (0 = unlimited)', () => {
    const spec = specByKey('REPLICATE_MONTHLY_BUDGET')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('int')
    expect(spec!.required).toBeFalsy()
    expect(spec!.validate!('0')).toBeNull()
    expect(spec!.validate!('950')).toBeNull()
    expect(typeof spec!.validate!('-1')).toBe('string')
  })
  it('REPLICATE_TIMEOUT_MS is an integer defaulting to 120000', () => {
    const spec = specByKey('REPLICATE_TIMEOUT_MS')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('int')
    expect(spec!.default).toBe('120000')
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
