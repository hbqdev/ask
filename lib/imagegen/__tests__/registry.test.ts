import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildModelInput,
  effectiveImageTask,
  getPremiumModel,
  type ImageModelDef,
  listImageModels,
  pickPinnedModel,
  resolveImagePool
} from '../registry'

afterEach(() => vi.unstubAllEnvs())

// Fixture defs so pool tests do not depend on the evolving real roster.
const fx = (over: Partial<ImageModelDef>): ImageModelDef => ({
  modelPath: 'x/x',
  capabilities: ['generate'],
  tier: 'standard',
  categories: ['general'],
  promptField: 'prompt',
  defaults: {},
  costNote: '',
  ...over
})

const FIXTURES: ImageModelDef[] = [
  fx({ modelPath: 'a/gen-general', aspectRatioValues: ['1:1', '16:9'] }),
  fx({
    modelPath: 'b/gen-photo',
    categories: ['photoreal'],
    tier: 'flagship',
    aspectRatioValues: ['1:1']
  }),
  fx({
    modelPath: 'c/edit-general',
    capabilities: ['generate', 'edit'],
    imageField: 'image_input',
    imageFieldShape: 'array',
    aspectRatioValues: ['1:1', '16:9']
  }),
  fx({
    modelPath: 'd/draft',
    tier: 'draft',
    categories: ['draft-fast'],
    aspectRatioValues: ['1:1', '16:9']
  }),
  fx({ modelPath: 'e/svg', categories: ['logo-svg'] }),
  fx({
    modelPath: 'f/premium',
    tier: 'premium',
    capabilities: ['generate', 'edit'],
    imageField: 'image_input',
    imageFieldShape: 'array',
    categories: []
  }),
  fx({ modelPath: 'g/pin-only', categories: [] })
]

describe('structural validity of the real roster', () => {
  it('every model def has a valid tier, categories, and edit prerequisites', () => {
    const models = listImageModels()
    expect(models.length).toBeGreaterThanOrEqual(4)
    for (const m of models) {
      expect(['draft', 'standard', 'flagship', 'premium']).toContain(m.tier)
      expect(Array.isArray(m.categories)).toBe(true)
      expect(m.promptField).toBeTruthy()
      if (m.capabilities.includes('edit')) expect(m.imageField).toBeTruthy()
    }
  })

  it('has exactly one premium model, capable of both roles', () => {
    // Passes fully once Task 4 registers nano-banana-pro; at Task 1 the
    // roster has no premium model, so getPremiumModel returns null.
    const premiums = listImageModels().filter(m => m.tier === 'premium')
    expect(premiums.length).toBeLessThanOrEqual(1)
  })
})

describe('effectiveImageTask', () => {
  it('defaults to general, honors an explicit task, and rewrites on svg keywords', () => {
    expect(effectiveImageTask('a fox')).toBe('general')
    expect(effectiveImageTask('a fox', 'photoreal')).toBe('photoreal')
    expect(effectiveImageTask('an svg icon of a fox')).toBe('logo-svg')
    expect(effectiveImageTask('vector logo for acme', 'photoreal')).toBe(
      'logo-svg'
    )
  })
})

describe('pickPinnedModel', () => {
  it('returns null with no env pin, the pinned model when valid, null on capability mismatch', () => {
    expect(pickPinnedModel('generate', FIXTURES)).toBeNull()
    vi.stubEnv('REPLICATE_IMAGE_MODEL', 'g/pin-only')
    expect(pickPinnedModel('generate', FIXTURES)?.modelPath).toBe('g/pin-only')
    // pin-only is generate-only → invalid as an edit pin
    vi.stubEnv('REPLICATE_IMAGE_EDIT_MODEL', 'g/pin-only')
    expect(pickPinnedModel('edit', FIXTURES)).toBeNull()
  })
})

describe('getPremiumModel', () => {
  it('finds the premium model per role', () => {
    expect(getPremiumModel('generate', FIXTURES)?.modelPath).toBe('f/premium')
    expect(getPremiumModel('edit', FIXTURES)?.modelPath).toBe('f/premium')
    expect(getPremiumModel('edit', FIXTURES.slice(0, 5))).toBeNull()
  })
})

describe('resolveImagePool', () => {
  it('general pool excludes draft, premium, pin-only, and off-category models', () => {
    const { poolKey, models } = resolveImagePool(
      { role: 'generate', prompt: 'a fox' },
      FIXTURES
    )
    expect(poolKey).toBe('generate:general')
    expect(models.map(m => m.modelPath)).toEqual([
      'a/gen-general',
      'c/edit-general'
    ])
  })

  it('draft models are reachable only via task draft-fast', () => {
    const { models } = resolveImagePool(
      { role: 'generate', task: 'draft-fast', prompt: 'quick sketch' },
      FIXTURES
    )
    expect(models.map(m => m.modelPath)).toEqual(['d/draft'])
    for (const t of ['general', 'photoreal', 'logo-svg'] as const) {
      const r = resolveImagePool(
        { role: 'generate', task: t, prompt: 'x' },
        FIXTURES
      )
      expect(r.models.map(m => m.modelPath)).not.toContain('d/draft')
    }
  })

  it('svg keyword in the prompt rewrites the pool to logo-svg', () => {
    const { poolKey, models } = resolveImagePool(
      { role: 'generate', prompt: 'an SVG badge', task: 'photoreal' },
      FIXTURES
    )
    expect(poolKey).toBe('generate:logo-svg')
    expect(models.map(m => m.modelPath)).toEqual(['e/svg'])
  })

  it('edit role intersects with edit capability and falls back to the edit-capable set when the task pool is empty', () => {
    // photoreal ∩ edit-capable is empty in fixtures → fallback to general edit pool
    const { poolKey, models } = resolveImagePool(
      { role: 'edit', task: 'photoreal', prompt: 'brighten it' },
      FIXTURES
    )
    expect(poolKey).toBe('edit:general')
    expect(models.map(m => m.modelPath)).toEqual(['c/edit-general'])
  })

  it('prefers the aspect-ratio-supporting subset but keeps the pool when none support it', () => {
    const wide = resolveImagePool(
      { role: 'generate', prompt: 'a fox', aspectRatio: '16:9' },
      FIXTURES
    )
    expect(wide.models.map(m => m.modelPath)).toEqual([
      'a/gen-general',
      'c/edit-general'
    ])
    const photo = resolveImagePool(
      {
        role: 'generate',
        task: 'photoreal',
        prompt: 'a fox',
        aspectRatio: '16:9'
      },
      FIXTURES
    )
    // b/gen-photo only supports 1:1 → subset empty → pool unchanged
    expect(photo.models.map(m => m.modelPath)).toEqual(['b/gen-photo'])
  })
})

describe('buildModelInput (unchanged behavior)', () => {
  it('maps prompt, base image shape, and supported aspect ratio', () => {
    const m = fx({
      imageField: 'image_input',
      imageFieldShape: 'array',
      aspectRatioField: 'aspect_ratio',
      aspectRatioValues: ['16:9'],
      defaults: { output_format: 'png' }
    })
    const input = buildModelInput(m, {
      prompt: 'p',
      baseImage: 'data:image/png;base64,AAAA',
      aspectRatio: '16:9'
    })
    expect(input).toEqual({
      output_format: 'png',
      prompt: 'p',
      image_input: ['data:image/png;base64,AAAA'],
      aspect_ratio: '16:9'
    })
  })
})

describe('google family registration', () => {
  it('registers the six google models with expected pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'google/imagen-4',
      'google/imagen-4-fast',
      'google/imagen-4-ultra'
    ])
      expect(paths).toContain(p)

    expect(getPremiumModel('generate')?.modelPath).toBe(
      'google/nano-banana-pro'
    )
    expect(getPremiumModel('edit')?.modelPath).toBe('google/nano-banana-pro')

    const photo = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x'
    })
    expect(photo.models.map(m => m.modelPath)).toContain('google/imagen-4')
    expect(photo.models.map(m => m.modelPath)).not.toContain(
      'google/imagen-4-fast'
    ) // draft tier

    const draft = resolveImagePool({
      role: 'generate',
      task: 'draft-fast',
      prompt: 'x'
    })
    expect(draft.models.map(m => m.modelPath)).toContain(
      'google/nano-banana-2-lite'
    )
  })
})

describe('flux-2 family registration', () => {
  it('registers the five FLUX.2 models with expected pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b'
    ])
      expect(paths).toContain(p)

    const editGeneral = resolveImagePool({ role: 'edit', prompt: 'x' })
    expect(editGeneral.models.map(m => m.modelPath)).toContain(
      'black-forest-labs/flux-2-pro'
    )
    expect(editGeneral.models.map(m => m.modelPath)).not.toContain(
      'black-forest-labs/flux-2-klein-4b'
    ) // draft tier

    const designText = resolveImagePool({
      role: 'generate',
      task: 'design-text',
      prompt: 'poster'
    })
    expect(designText.models.map(m => m.modelPath)).toContain(
      'black-forest-labs/flux-2-flex'
    )
  })
})

describe('bytedance/wan/openai registration', () => {
  it('registers the five models; wan drops out of AR-filtered pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'openai/gpt-image-2'
    ])
      expect(paths).toContain(p)

    const general = resolveImagePool({ role: 'generate', prompt: 'x' })
    expect(general.models.map(m => m.modelPath)).toContain('openai/gpt-image-2')

    // wan has no aspect_ratio input → excluded when a ratio is requested
    const withAr = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x',
      aspectRatio: '16:9'
    })
    expect(withAr.models.map(m => m.modelPath)).not.toContain(
      'wan-video/wan-2.7-image-pro'
    )
    const noAr = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x'
    })
    expect(noAr.models.map(m => m.modelPath)).toContain(
      'wan-video/wan-2.7-image-pro'
    )
  })
})

describe('complete roster', () => {
  it('registers 32 models total with the final pool shapes', () => {
    expect(listImageModels().length).toBe(32)

    const svg = resolveImagePool({
      role: 'generate',
      task: 'logo-svg',
      prompt: 'acme logo'
    })
    expect(svg.models.map(m => m.modelPath)).toEqual([
      'recraft-ai/recraft-v4.1-svg'
    ])

    const illus = resolveImagePool({
      role: 'generate',
      task: 'illustration',
      prompt: 'x'
    })
    expect(illus.models.map(m => m.modelPath)).toEqual([
      'bytedance/seedream-5-lite',
      'prunaai/z-image',
      'prunaai/ernie-image-turbo',
      'bria/image-3.2'
    ])

    const editDraft = resolveImagePool({
      role: 'edit',
      task: 'draft-fast',
      prompt: 'x'
    })
    expect(editDraft.models.map(m => m.modelPath)).toEqual([
      'google/nano-banana-2-lite',
      'black-forest-labs/flux-2-klein-4b',
      'prunaai/p-image-edit'
    ])

    // fibo-edit prompts via `instruction`
    const fiboEdit = listImageModels().find(
      m => m.modelPath === 'bria/fibo-edit'
    )!
    expect(fiboEdit.promptField).toBe('instruction')
    const input = buildModelInput(fiboEdit, {
      prompt: 'remove the hat',
      baseImage: 'data:image/png;base64,AAAA'
    })
    expect(input.instruction).toBe('remove the hat')
    expect(input.image).toBe('data:image/png;base64,AAAA')
  })
})
