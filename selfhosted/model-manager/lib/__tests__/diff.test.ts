import { describe, expect, it } from 'vitest'
import { computeChanges, MASK, renderDiff } from '../diff'

describe('diff', () => {
  it('detects add / change / remove', () => {
    const c = computeChanges(
      { A: '1', B: 'x', RERANKER_API_TOKEN: 'old' },
      { A: '1', B: 'y', C: 'new', RERANKER_API_TOKEN: 'new' }
    )
    const byKey = Object.fromEntries(c.map(ch => [ch.key, ch]))
    expect(byKey.A).toBeUndefined() // unchanged
    expect(byKey.B.kind).toBe('change')
    expect(byKey.C.kind).toBe('add')
    expect(byKey.RERANKER_API_TOKEN.secret).toBe(true)
  })
  it('masks secret values in the rendered diff', () => {
    const out = renderDiff(
      computeChanges(
        { RERANKER_API_TOKEN: 'old' },
        { RERANKER_API_TOKEN: 'new' }
      )
    )
    expect(out).toContain(MASK)
    expect(out).not.toContain('old')
    expect(out).not.toContain('new')
  })
  it('shows non-secret values in the rendered diff', () => {
    const out = renderDiff(
      computeChanges(
        { OLLAMA_BASE_URL: 'http://a' },
        { OLLAMA_BASE_URL: 'http://b' }
      )
    )
    expect(out).toContain('http://a')
    expect(out).toContain('http://b')
  })
  it('masks a secret ADD (before absent)', () => {
    const out = renderDiff(
      computeChanges({}, { RERANKER_API_TOKEN: 'plaintextsecret' })
    )
    expect(out).toContain(MASK)
    expect(out).not.toContain('plaintextsecret')
  })

  it('masks a secret REMOVE (after absent)', () => {
    const out = renderDiff(
      computeChanges({ RERANKER_API_TOKEN: 'plaintextsecret' }, {})
    )
    expect(out).toContain(MASK)
    expect(out).not.toContain('plaintextsecret')
  })
})
