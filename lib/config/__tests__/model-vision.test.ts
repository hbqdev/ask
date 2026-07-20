import { describe, expect, it } from 'vitest'

import { modelSupportsVision } from '../model-vision'

describe('modelSupportsVision', () => {
  it('honors an explicit vision flag over inference', () => {
    // Explicit false wins even for an id that would otherwise infer true.
    expect(modelSupportsVision({ id: 'gemini-3-flash', vision: false })).toBe(
      false
    )
    // Explicit true wins even for an id that would otherwise infer false.
    expect(modelSupportsVision({ id: 'deepseek-v4-flash', vision: true })).toBe(
      true
    )
  })

  it('infers vision for known multimodal families', () => {
    for (const id of [
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite',
      'gpt-4o',
      'gpt-4.1-mini',
      'gpt-5',
      'o3',
      'claude-3-5-sonnet',
      'claude-sonnet-4-5',
      'qwen3-vl',
      'pixtral-12b',
      'llava-1.6'
    ]) {
      expect(modelSupportsVision({ id })).toBe(true)
    }
  })

  it('treats unknown / text-only models as non-vision (safe fallback)', () => {
    for (const id of [
      'deepseek-v4-flash',
      'kimi-k2.6',
      'granite4.1:8b',
      'minimax-m3',
      'mistral-large'
    ]) {
      expect(modelSupportsVision({ id })).toBe(false)
    }
  })
})
