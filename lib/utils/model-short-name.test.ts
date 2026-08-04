import { describe, expect, test } from 'vitest'

import { modelShortName } from './model-short-name'

describe('modelShortName', () => {
  test('drops the shared cloud/free/latest tag', () => {
    expect(modelShortName('kimi-k2.6:cloud')).toBe('kimi-k2.6')
    expect(modelShortName('deepseek-v4-pro:cloud')).toBe('deepseek-v4-pro')
    expect(modelShortName('some-model:free')).toBe('some-model')
    expect(modelShortName('other:latest')).toBe('other')
  })

  test('keeps a meaningful internal colon (e.g. size tag)', () => {
    // qwen3.5:397b is the model identity, not a cloud tag — keep it
    expect(modelShortName('qwen3.5:397b')).toBe('qwen3.5:397b')
  })

  test('returns names without a known tag unchanged', () => {
    expect(modelShortName('gpt-5')).toBe('gpt-5')
    expect(modelShortName('minimax-m3')).toBe('minimax-m3')
  })

  test('tolerates empty / non-string input', () => {
    expect(modelShortName('')).toBe('')
    // @ts-expect-error runtime guard
    expect(modelShortName(undefined)).toBe('')
  })
})
