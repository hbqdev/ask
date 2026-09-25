import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  boolIsOn,
  boolLiteral,
  CATEGORIES,
  REGISTRY,
  specByKey
} from '../env-schema'

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
    // Placeholder shows the code default: unset = expiry disabled.
    expect(spec!.default).toBe('0')
  })
  it('validates as a non-negative integer (0 disables, negatives rejected)', () => {
    expect(spec!.validate!('14')).toBeNull()
    expect(spec!.validate!('0')).toBeNull()
    expect(typeof spec!.validate!('-1')).toBe('string')
    expect(typeof spec!.validate!('3.5')).toBe('string')
    expect(typeof spec!.validate!('abc')).toBe('string')
  })
})

describe('EMBEDDING_MODEL', () => {
  const spec = specByKey('EMBEDDING_MODEL')
  it('is read-only (stored vectors are locked to Qwen3), not a dropdown', () => {
    expect(spec).toBeDefined()
    expect(spec!.readOnly).toBe(true)
    expect(spec!.type).not.toBe('enum')
    expect(spec!.enumValues).toBeUndefined()
    expect(spec!.default).toBe('Qwen/Qwen3-Embedding-0.6B')
    expect(spec!.help).toMatch(/corrupt/i)
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

// What Ask does when each boolean key is UNSET, read from the app's code (not
// the old UI, which showed every unset bool as "Disabled"). A new bool must
// be added here, i.e. audited against the app, before this suite passes.
const APP_UNSET_BEHAVIOUR: Record<string, boolean> = {
  // `!== 'off'` / `=== 'off'` kill switches — unset = ON
  OLLAMA_SEARCH_ENABLED: true, // lib/tools/search.ts
  MEMORY_ENABLED: true, // lib/db/memory-actions.ts, create-chat-stream-response.ts
  RECALL_ENABLED: true, // lib/db/recall-actions.ts, create-chat-stream-response.ts
  // `=== 'false'` disables — unset = ON
  ENABLE_AUTH: true, // lib/auth/get-current-user.ts, lib/supabase/middleware.ts
  // `=== 'true'` enables — unset = OFF
  DATABASE_SSL_DISABLED: false, // lib/db/index.ts, lib/db/migrate.ts
  MORPHIC_CLOUD_DEPLOYMENT: false // lib/auth/get-current-user.ts, lib/analytics, …
}

describe('boolean flags show and write what Ask actually does', () => {
  const bools = REGISTRY.filter(s => s.type === 'bool')

  it('every bool has been audited against the app', () => {
    expect(bools.map(s => s.key).sort()).toEqual(
      Object.keys(APP_UNSET_BEHAVIOUR).sort()
    )
  })

  it.each(Object.entries(APP_UNSET_BEHAVIOUR))(
    '%s: display default matches the app when unset (on=%s)',
    (key, on) => {
      const spec = specByKey(key)!
      expect(spec.default).toBeDefined()
      expect(boolIsOn(spec, '')).toBe(on)
      expect(boolIsOn(spec, spec.default!)).toBe(on)
      // …and the default is the literal the switch itself would write.
      expect(boolLiteral(spec, on)).toBe(spec.default)
    }
  )

  it('RECALL_ENABLED unset is ON (was shown as Disabled)', () => {
    const spec = specByKey('RECALL_ENABLED')!
    expect(spec.default).toBe('on')
    expect(boolIsOn(spec, '')).toBe(true)
  })

  it('kill switches: only `off` disables, so the switch writes on/off, never false', () => {
    for (const key of [
      'RECALL_ENABLED',
      'MEMORY_ENABLED',
      'OLLAMA_SEARCH_ENABLED'
    ]) {
      const spec = specByKey(key)!
      expect(boolIsOn(spec, 'off')).toBe(false)
      // The app reads `false` as ON — it must not look like "Disabled"…
      expect(boolIsOn(spec, 'false')).toBe(true)
      // …and the UI must never write it to mean "off".
      expect(boolLiteral(spec, false)).toBe('off')
      expect(boolLiteral(spec, true)).toBe('on')
      expect(spec.validate!('off')).toBeNull()
      expect(spec.validate!('on')).toBeNull()
      expect(spec.validate!('false')).toMatch(/only on `off`/)
    }
  })

  it('ENABLE_AUTH is off only for `false`; SSL/cloud flags only on for `true`', () => {
    const auth = specByKey('ENABLE_AUTH')!
    expect(boolIsOn(auth, 'false')).toBe(false)
    expect(boolIsOn(auth, 'true')).toBe(true)
    expect(boolLiteral(auth, false)).toBe('false')
    for (const key of ['DATABASE_SSL_DISABLED', 'MORPHIC_CLOUD_DEPLOYMENT']) {
      const spec = specByKey(key)!
      expect(boolIsOn(spec, 'true')).toBe(true)
      expect(boolIsOn(spec, 'false')).toBe(false)
      expect(boolIsOn(spec, 'yes')).toBe(false)
    }
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
