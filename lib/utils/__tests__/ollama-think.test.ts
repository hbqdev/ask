import { afterEach, describe, expect, it } from 'vitest'

import {
  ANSWER_THINK_DEFAULT,
  resolveAnswerThink,
  thinkEnabledForOllama
} from '@/lib/utils/ollama-think'

// The answering model's reasoning is the single largest remaining latency
// source (measured on prod: a 131.7s turn spent 85.4s deliberating, one 38,684-
// char reasoning block against an 8,730-char answer). resolveAnswerThink is the
// model-agnostic control that dials it down: registry.ts hands its return value
// straight to ai-sdk-ollama as the Ollama `think` field, which accepts
// boolean | 'low' | 'medium' | 'high'.
describe('resolveAnswerThink', () => {
  afterEach(() => {
    delete process.env.ANSWER_THINK
    delete process.env.OLLAMA_THINK
  })

  it('falls back to the shipped default when nothing is set', () => {
    delete process.env.ANSWER_THINK
    delete process.env.OLLAMA_THINK
    expect(resolveAnswerThink()).toBe(ANSWER_THINK_DEFAULT)
  })

  it('maps ANSWER_THINK=off (and aliases) to false', () => {
    for (const v of ['off', 'false', 'none', 'no', 'disabled', '0']) {
      process.env.ANSWER_THINK = v
      expect(resolveAnswerThink()).toBe(false)
    }
  })

  it('maps effort levels to their string, so a reduced level reaches the model', () => {
    process.env.ANSWER_THINK = 'low'
    expect(resolveAnswerThink()).toBe('low')
    process.env.ANSWER_THINK = 'medium'
    expect(resolveAnswerThink()).toBe('medium')
    process.env.ANSWER_THINK = 'high'
    expect(resolveAnswerThink()).toBe('high')
  })

  it('maps ANSWER_THINK=on (and aliases) to full reasoning', () => {
    for (const v of ['on', 'true', 'yes', '1']) {
      process.env.ANSWER_THINK = v
      expect(resolveAnswerThink()).toBe(true)
    }
  })

  it('treats an unknown ANSWER_THINK value as on, so a typo cannot silently disable reasoning', () => {
    process.env.ANSWER_THINK = 'lowww'
    expect(resolveAnswerThink()).toBe(true)
  })

  it('ANSWER_THINK takes precedence over the legacy OLLAMA_THINK', () => {
    process.env.OLLAMA_THINK = 'false'
    process.env.ANSWER_THINK = 'high'
    expect(resolveAnswerThink()).toBe('high')
  })

  it('honours the legacy OLLAMA_THINK boolean when ANSWER_THINK is unset', () => {
    delete process.env.ANSWER_THINK
    process.env.OLLAMA_THINK = 'false'
    expect(resolveAnswerThink()).toBe(false)
    process.env.OLLAMA_THINK = 'anything-else'
    expect(resolveAnswerThink()).toBe(true)
  })
})

describe('thinkEnabledForOllama (boolean view)', () => {
  afterEach(() => {
    delete process.env.ANSWER_THINK
    delete process.env.OLLAMA_THINK
  })

  it('is true for any enabled level including a reduced one', () => {
    process.env.ANSWER_THINK = 'low'
    expect(thinkEnabledForOllama()).toBe(true)
  })

  it('is false only when reasoning is disabled', () => {
    process.env.ANSWER_THINK = 'off'
    expect(thinkEnabledForOllama()).toBe(false)
  })
})
