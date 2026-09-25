import { specByKey } from '../env-schema'
import { describe, expect, it } from 'vitest'
import { buildPlan, validateEdits } from '../plan-builder'

const CURRENT = `OLLAMA_BASE_URL=http://a:11434
CLASSIFIER_MODEL_ID=granite4.1:8b
RERANKER_URL=http://r:8787
RERANKER_MODEL=BAAI/bge-reranker-v2-m3
`

describe('buildPlan', () => {
  it('marks ask target when an ask var changes', () => {
    const { plan, changes } = buildPlan(CURRENT, {
      CLASSIFIER_MODEL_ID: 'qwen3:8b'
    })
    expect(plan.touchedTargets).toContain('ask')
    expect(plan.touchedTargets).not.toContain('reranker')
    expect(plan.askEnvText).toContain('CLASSIFIER_MODEL_ID=qwen3:8b')
    expect(changes.find(c => c.key === 'CLASSIFIER_MODEL_ID')?.kind).toBe(
      'change'
    )
  })
  it('marks reranker target and builds reranker env when RERANKER_MODEL changes', () => {
    const { plan } = buildPlan(CURRENT, {
      RERANKER_MODEL: 'BAAI/bge-reranker-base'
    })
    expect(plan.touchedTargets).toContain('reranker')
    expect(plan.rerankerEnvText).toContain(
      'RERANKER_MODEL=BAAI/bge-reranker-base'
    )
    // reranker model must NOT be written into Ask's .env
    expect(plan.askEnvText).not.toContain(
      'RERANKER_MODEL=BAAI/bge-reranker-base'
    )
  })
  it('no edits ⇒ no targets', () => {
    const { plan, changes } = buildPlan(CURRENT, {})
    expect(plan.touchedTargets).toHaveLength(0)
    expect(changes).toHaveLength(0)
  })
  it('validateEdits flags unknown keys and values failing their validator', () => {
    const v = validateEdits({
      OLLAMA_BASE_URL: 'not-a-url', // fails the url validator
      TOTALLY_UNKNOWN_KEY: 'x', // not in the registry
      CLASSIFIER_MODEL_ID: 'granite4.1:8b' // valid, no validator
    })
    const byKey = Object.fromEntries(v.map(x => [x.key, x.error]))
    expect(byKey.OLLAMA_BASE_URL).toBeTruthy()
    expect(byKey.TOTALLY_UNKNOWN_KEY).toBeTruthy()
    expect(byKey.CLASSIFIER_MODEL_ID).toBeUndefined()
  })
  it('validateEdits passes a well-formed edit set', () => {
    expect(
      validateEdits({ OLLAMA_BASE_URL: 'http://192.168.50.231:11434' })
    ).toEqual([])
  })
  it('buildPlan defensively ignores an unknown key', () => {
    const { plan, changes } = buildPlan('OLLAMA_BASE_URL=http://a:11434\n', {
      TOTALLY_UNKNOWN_KEY: 'x'
    })
    expect(plan.askEnvText).not.toContain('TOTALLY_UNKNOWN_KEY')
    expect(plan.touchedTargets).toHaveLength(0)
    expect(changes.find(c => c.key === 'TOTALLY_UNKNOWN_KEY')).toBeUndefined()
  })
  it('rejects edits to a read-only key and never writes it', () => {
    expect(
      validateEdits({ EMBEDDING_MODEL: 'mixedbread-ai/mxbai-embed-large-v1' })
    ).toEqual([{ key: 'EMBEDDING_MODEL', error: 'This setting is read-only' }])
    const { plan, changes } = buildPlan(CURRENT, {
      EMBEDDING_MODEL: 'mixedbread-ai/mxbai-embed-large-v1'
    })
    expect(plan.touchedTargets).toHaveLength(0)
    expect(plan.askEnvText).not.toContain('EMBEDDING_MODEL')
    expect(changes).toHaveLength(0)
  })
  it('clearing an optional secret writes an empty value', () => {
    const { plan, changes } = buildPlan('RERANKER_API_TOKEN=sekrit\n', {
      RERANKER_API_TOKEN: ''
    })
    expect(validateEdits({ RERANKER_API_TOKEN: '' })).toEqual([])
    expect(plan.askEnvText).toMatch(/^RERANKER_API_TOKEN=("")?$/m)
    expect(plan.askEnvText).not.toContain('sekrit')
    expect(changes[0]).toMatchObject({ key: 'RERANKER_API_TOKEN', after: '' })
  })
  it('validateEdits rejects `false` for a kill switch (a silent no-op in Ask)', () => {
    expect(validateEdits({ RECALL_ENABLED: 'false' })).toEqual([
      { key: 'RECALL_ENABLED', error: expect.stringMatching(/on or off/) }
    ])
    expect(validateEdits({ RECALL_ENABLED: 'off' })).toEqual([])
    expect(validateEdits({ MEMORY_ENABLED: 'on' })).toEqual([])
    expect(validateEdits({ ENABLE_AUTH: 'false' })).toEqual([])
  })
  it('validateEdits refuses to empty a required var', () => {
    const spec = specByKey('RERANKER_API_TOKEN')!
    spec.required = true
    try {
      expect(validateEdits({ RERANKER_API_TOKEN: ' ' })).toEqual([
        { key: 'RERANKER_API_TOKEN', error: 'This setting is required' }
      ])
    } finally {
      delete spec.required
    }
  })
})
