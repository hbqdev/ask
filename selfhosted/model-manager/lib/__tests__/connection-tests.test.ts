import { describe, expect, it, vi } from 'vitest'
import { testOllama, testReranker } from '../connection-tests'

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('connection tests', () => {
  it('lists ollama models from /api/tags', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ models: [{ name: 'granite4.1:8b' }, { name: 'llama3' }] })
      )
    const r = await testOllama('http://h:11434', f as unknown as typeof fetch)
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['granite4.1:8b', 'llama3'])
    expect(f).toHaveBeenCalledWith('http://h:11434/api/tags', expect.anything())
  })
  it('reports ollama failure', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await testOllama('http://h:11434', f as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ECONNREFUSED')
  })
  it('checks reranker /health with bearer', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ status: 'ok' }))
    const r = await testReranker(
      'http://h:8787',
      'tok',
      f as unknown as typeof fetch
    )
    expect(r.ok).toBe(true)
    const [, init] = f.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok'
    })
  })
  it('reports reranker non-200', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({}, 503))
    const r = await testReranker(
      'http://h:8787',
      'tok',
      f as unknown as typeof fetch
    )
    expect(r.ok).toBe(false)
  })
})
