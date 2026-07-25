import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('couchbase', () => ({ connect: vi.fn() }))

const ENV_KEYS = [
  'COUCHBASE_URL',
  'COUCHBASE_USERNAME',
  'COUCHBASE_PASSWORD',
  'COUCHBASE_QUOTES_BUCKET',
  'COUCHBASE_QUOTES_DOC'
] as const

function setEnv() {
  process.env.COUCHBASE_URL = 'cb.example'
  process.env.COUCHBASE_USERNAME = 'user'
  process.env.COUCHBASE_PASSWORD = 'pass'
}

/**
 * Records the document coordinates the subject asks for. Passed in by the
 * tests that pin the document contract; defaulted for the ones that do not
 * care, so every call site keeps working.
 */
type DocumentCalls = { bucket?: string; docId?: string }

function clusterReturning(content: unknown, calls: DocumentCalls = {}) {
  return {
    bucket: (bucketName: string) => {
      calls.bucket = bucketName
      return {
        defaultCollection: () => ({
          get: async (docId: string) => {
            calls.docId = docId
            return { content }
          }
        })
      }
    }
  }
}

/**
 * The module memoises its cluster connection for the process lifetime, so a
 * single top-level import would carry the first test's cluster into every
 * later test. Reset the registry and re-import per test — `connect` has to
 * come from the same fresh module instance the subject under test sees.
 */
async function loadFresh() {
  vi.resetModules()
  const { connect } = await import('couchbase')
  const { fetchQuotesFromCouchbase } = await import('../couchbase-quotes')
  return { connect: vi.mocked(connect), fetchQuotesFromCouchbase }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('fetchQuotesFromCouchbase', () => {
  it('returns the quotes array from the document', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    const calls: DocumentCalls = {}
    connect.mockResolvedValue(
      clusterReturning({ quotes: [{ q: 'One.', a: 'A' }] }, calls) as never
    )

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([
      { q: 'One.', a: 'A' }
    ])

    // Credentials belong in the options object, never in the connection
    // string — that string is the part most likely to reach a log line or an
    // error message. Asserted both ways round so a mutant that folds
    // `user:pass@` into the URL cannot slip through.
    expect(connect).toHaveBeenCalledWith('couchbase://cb.example', {
      username: 'user',
      password: 'pass'
    })
    const [connectionString] = connect.mock.calls[0]
    expect(connectionString).not.toContain('user')
    expect(connectionString).not.toContain('pass')

    // Default document coordinates.
    expect(calls.bucket).toBe('Quotes')
    expect(calls.docId).toBe('quotes_collection')
  })

  it('honours the bucket and document env overrides', async () => {
    setEnv()
    process.env.COUCHBASE_QUOTES_BUCKET = 'OtherBucket'
    process.env.COUCHBASE_QUOTES_DOC = 'other_doc'
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    const calls: DocumentCalls = {}
    connect.mockResolvedValue(
      clusterReturning({ quotes: [{ q: 'One.', a: 'A' }] }, calls) as never
    )

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([
      { q: 'One.', a: 'A' }
    ])

    expect(calls.bucket).toBe('OtherBucket')
    expect(calls.docId).toBe('other_doc')
  })

  it('returns rows unvalidated, leaving normalisation to the caller', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    const rows = [{ q: 'One.', a: 'A' }, { q: '', a: '' }, { junk: true }]
    connect.mockResolvedValue(clusterReturning({ quotes: rows }) as never)

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual(rows)
  })

  it('returns empty without connecting when credentials are absent', async () => {
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
    expect(connect).not.toHaveBeenCalled()
  })

  it('returns empty when the cluster is unreachable, and does not throw', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    connect.mockRejectedValue(new Error('unreachable'))

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
  })

  it('returns empty when the document has an unexpected shape', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    connect.mockResolvedValue(clusterReturning({ nope: true }) as never)

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])
  })

  it('reuses one connection across calls', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    connect.mockResolvedValue(
      clusterReturning({ quotes: [{ q: 'One.', a: 'A' }] }) as never
    )

    await fetchQuotesFromCouchbase()
    await fetchQuotesFromCouchbase()

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed connection instead of caching the failure', async () => {
    setEnv()
    const { connect, fetchQuotesFromCouchbase } = await loadFresh()
    connect.mockRejectedValueOnce(new Error('unreachable'))

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([])

    connect.mockResolvedValueOnce(
      clusterReturning({ quotes: [{ q: 'Two.', a: 'B' }] }) as never
    )

    await expect(fetchQuotesFromCouchbase()).resolves.toEqual([
      { q: 'Two.', a: 'B' }
    ])
    expect(connect).toHaveBeenCalledTimes(2)
  })
})
