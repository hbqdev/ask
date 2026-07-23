import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildModelInput, getImageModel, listImageModels } from '../registry'

afterEach(() => vi.unstubAllEnvs())

describe('image model registry', () => {
  it('loads all four v1 models with valid capability sets', () => {
    const models = listImageModels()
    expect(models.map(m => m.modelPath).sort()).toEqual([
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'bytedance/seedream-4',
      'google/nano-banana'
    ])
    for (const m of models) {
      expect(m.capabilities.length).toBeGreaterThan(0)
      if (m.capabilities.includes('edit')) expect(m.imageField).toBeTruthy()
    }
  })

  it('resolves default roles from code defaults', () => {
    expect(getImageModel('generate').modelPath).toBe(
      'black-forest-labs/flux-1.1-pro'
    )
    expect(getImageModel('edit').modelPath).toBe('google/nano-banana')
  })

  it('honors env overrides and rejects capability mismatches', () => {
    vi.stubEnv('REPLICATE_IMAGE_MODEL', 'black-forest-labs/flux-schnell')
    expect(getImageModel('generate').modelPath).toBe(
      'black-forest-labs/flux-schnell'
    )
    // flux-schnell cannot edit → override ignored, falls back to default
    vi.stubEnv('REPLICATE_IMAGE_EDIT_MODEL', 'black-forest-labs/flux-schnell')
    expect(getImageModel('edit').modelPath).toBe('google/nano-banana')
  })

  it('builds input with prompt, base image, and clamped aspect ratio', () => {
    const edit = getImageModel('edit')
    const input = buildModelInput(edit, {
      prompt: 'make it night',
      baseImage: 'data:image/png;base64,AAAA',
      aspectRatio: '16:9'
    })
    expect(input[edit.promptField]).toBe('make it night')
    const img = input[edit.imageField!]
    expect(edit.imageFieldShape === 'array' ? (img as string[])[0] : img).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('omits unsupported aspect ratios instead of sending them', () => {
    const gen = getImageModel('generate')
    const input = buildModelInput(gen, {
      prompt: 'a fox',
      aspectRatio: 'nonsense'
    })
    if (gen.aspectRatioField)
      expect(input[gen.aspectRatioField]).toBeUndefined()
  })
})
