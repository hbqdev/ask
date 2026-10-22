import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  categoryLabel,
  clearMemories,
  clearRecallIndex,
  deleteMemory,
  fetchMemory,
  MAX_REBUILD_ROUNDS,
  MEMORY_UNAVAILABLE,
  memoryErrorText,
  REBUILD_BATCH_TIMEOUT_MS,
  REBUILD_FAILED,
  REBUILD_TIMED_OUT,
  rebuildErrorText,
  rebuildRecallBatch,
  rebuildRecallIndex,
  RECALL_REFRESH_TIMEOUT_MS,
  refreshRecallStatus,
  saveMemorySettings,
  type RecallBatch
} from '@/features/settings/memory-api'
import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'

const BASE = 'https://ask.test.invalid'

type Respond = (init: RequestInit) => Response | Promise<Response>

function client(respond: Respond) {
  const fetchImpl = vi.fn(
    async (_input: RequestInfo | URL, init: RequestInit = {}) => respond(init)
  )
  return {
    fetchImpl,
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl
    })
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

function request(fetchImpl: ReturnType<typeof client>['fetchImpl'], n = 0) {
  const [url, init] = fetchImpl.mock.calls[n]
  return { url: String(url), init: init ?? {} }
}

/** A response that only settles when the request's signal aborts (as fetch). */
const hang: Respond = ({ signal }) =>
  new Promise((_resolve, reject) => {
    if (signal!.aborted) reject(signal!.reason)
    signal!.addEventListener('abort', () => reject(signal!.reason))
  })

const MEMORY = {
  id: 'm1',
  content: 'Prefers metric units',
  category: 'preference',
  status: 'confirmed',
  updatedAt: '2026-10-21T08:00:00.000Z',
  lastUsedAt: null
}

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchMemory', () => {
  it('GETs /api/memory and returns the settings, recall status and memories', async () => {
    const body = {
      enabled: true,
      recallEnabled: false,
      recall: { chunks: 12, chats: 3 },
      memories: [MEMORY]
    }
    const { client: api, fetchImpl } = client(() => json(body))
    await expect(fetchMemory(api)).resolves.toEqual(body)
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory`)
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('passes a signal through', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({
        enabled: true,
        recallEnabled: true,
        recall: { chunks: 0, chats: 0 },
        memories: []
      })
    )
    const controller = new AbortController()
    await fetchMemory(api, controller.signal)
    expect(request(fetchImpl).init.signal).toBe(controller.signal)
  })

  it('rejects with the server’s status', async () => {
    const { client: api } = client(() => json({ error: 'Unauthorized' }, 401))
    await expect(fetchMemory(api)).rejects.toMatchObject({ status: 401 })
  })
})

describe('refreshRecallStatus', () => {
  it('GETs /api/memory and returns the recall index’s size', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({
        enabled: true,
        recallEnabled: true,
        recall: { chunks: 40, chats: 4 },
        memories: [MEMORY]
      })
    )
    await expect(refreshRecallStatus(api)).resolves.toEqual({
      chunks: 40,
      chats: 4
    })
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory`)
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('gives up after its timeout, so a hung refresh never stalls a rebuild', async () => {
    vi.useFakeTimers()
    const { client: api } = client(hang)
    const result = refreshRecallStatus(api)
    const settled = expect(result).rejects.toMatchObject({
      status: 0,
      retryable: true
    })
    let done = false
    void result.catch(() => {}).finally(() => (done = true))
    await vi.advanceTimersByTimeAsync(RECALL_REFRESH_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(vi.getTimerCount()).toBe(0)
    expect(RECALL_REFRESH_TIMEOUT_MS).toBe(15_000)
  })

  it('stops when the caller aborts, with the caller’s reason', async () => {
    const { client: api } = client(hang)
    const controller = new AbortController()
    const result = refreshRecallStatus(api, { signal: controller.signal })
    const reason = new Error('paused')
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
  })
})

describe('saveMemorySettings', () => {
  it('PUTs only the given key as JSON and returns the stored values', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ ok: true, enabled: false, recallEnabled: true })
    )
    await expect(
      saveMemorySettings(api, { memoryEnabled: false })
    ).resolves.toEqual({ enabled: false, recallEnabled: true })
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/settings/memory`)
    expect(init.method).toBe('PUT')
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json'
    )
    expect(JSON.parse(String(init.body))).toEqual({ memoryEnabled: false })
  })

  it('sends recallEnabled', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ ok: true, enabled: true, recallEnabled: false })
    )
    await saveMemorySettings(api, { recallEnabled: false })
    expect(JSON.parse(String(request(fetchImpl).init.body))).toEqual({
      recallEnabled: false
    })
  })

  it('rejects on a 400', async () => {
    const { client: api } = client(() =>
      json({ error: 'Invalid memory settings' }, 400)
    )
    await expect(
      saveMemorySettings(api, { recallEnabled: true })
    ).rejects.toMatchObject({ status: 400, message: 'Invalid memory settings' })
  })
})

describe('deleteMemory', () => {
  it('DELETEs /api/memory/{id}, encoding the id', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await deleteMemory(api, 'a/b')
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory/a%2Fb`)
    expect(init.method).toBe('DELETE')
  })

  it('rejects with a 404 when the memory is gone', async () => {
    const { client: api } = client(() => json({ error: 'Not found' }, 404))
    await expect(deleteMemory(api, 'm1')).rejects.toMatchObject({
      status: 404
    })
  })
})

describe('clearMemories', () => {
  it('DELETEs /api/memory', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await clearMemories(api)
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory`)
    expect(init.method).toBe('DELETE')
  })
})

describe('clearRecallIndex', () => {
  it('DELETEs /api/memory/recall', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await clearRecallIndex(api)
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory/recall`)
    expect(init.method).toBe('DELETE')
  })
})

describe('rebuildRecallBatch', () => {
  it('POSTs /api/memory/recall and returns the batch', async () => {
    const batch = { messages: 95, chunks: 270, done: false }
    const { client: api, fetchImpl } = client(() => json(batch))
    await expect(rebuildRecallBatch(api)).resolves.toEqual(batch)
    const { url, init } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/memory/recall`)
    expect(init.method).toBe('POST')
  })

  it('allows a batch at least two minutes', () => {
    expect(REBUILD_BATCH_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('gives up after the timeout with a retryable error', async () => {
    vi.useFakeTimers()
    const { client: api } = client(hang)
    const result = rebuildRecallBatch(api, { timeoutMs: 1000 })
    const settled = expect(result).rejects.toMatchObject({
      status: 0,
      message: REBUILD_TIMED_OUT,
      retryable: true
    })
    let done = false
    void result.catch(() => {}).finally(() => (done = true))
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops when the caller aborts, with the caller’s reason', async () => {
    const { client: api } = client(hang)
    const controller = new AbortController()
    const result = rebuildRecallBatch(api, { signal: controller.signal })
    const reason = new Error('left the screen')
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
  })

  it('never sends when the caller already aborted', async () => {
    const { client: api, fetchImpl } = client(hang)
    const controller = new AbortController()
    const reason = new Error('gone')
    controller.abort(reason)
    await expect(
      rebuildRecallBatch(api, { signal: controller.signal })
    ).rejects.toBe(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('stops listening to the caller’s signal and the clock once settled', async () => {
    vi.useFakeTimers()
    const { client: api } = client(() =>
      json({ messages: 0, chunks: 0, done: true })
    )
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await rebuildRecallBatch(api, { signal: controller.signal })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes a server error through', async () => {
    const { client: api } = client(() =>
      json({ error: 'Rebuild failed — see server logs', retryable: true }, 500)
    )
    await expect(rebuildRecallBatch(api)).rejects.toMatchObject({
      status: 500,
      message: 'Rebuild failed — see server logs'
    })
  })
})

describe('rebuildRecallIndex', () => {
  /** A server answering each POST with the next batch. */
  function batches(...list: RecallBatch[]) {
    let i = 0
    return client(() => json(list[Math.min(i++, list.length - 1)]))
  }

  it('loops until a batch is done, reporting each batch and the total', async () => {
    const { client: api, fetchImpl } = batches(
      { messages: 100, chunks: 300, done: false },
      { messages: 40, chunks: 90, done: false },
      { messages: 0, chunks: 0, done: true }
    )
    const onBatch = vi.fn()
    await expect(rebuildRecallIndex(api, { onBatch })).resolves.toEqual({
      kind: 'done',
      messages: 140
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(onBatch.mock.calls).toEqual([
      [{ messages: 100, chunks: 300, done: false }, 100],
      [{ messages: 40, chunks: 90, done: false }, 140],
      [{ messages: 0, chunks: 0, done: true }, 140]
    ])
  })

  it('waits for onBatch before the next batch', async () => {
    const { client: api, fetchImpl } = batches(
      { messages: 10, chunks: 20, done: false },
      { messages: 0, chunks: 0, done: true }
    )
    let release!: () => void
    const onBatch = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const result = rebuildRecallIndex(api, { onBatch })
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledOnce())
    expect(fetchImpl).toHaveBeenCalledOnce()
    release()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    release()
    await expect(result).resolves.toEqual({ kind: 'done', messages: 10 })
  })

  it('is done at once when there is nothing to index', async () => {
    const { client: api, fetchImpl } = batches({
      messages: 0,
      chunks: 0,
      done: true
    })
    await expect(rebuildRecallIndex(api)).resolves.toEqual({
      kind: 'done',
      messages: 0
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('stops on a batch that tried messages but indexed nothing', async () => {
    const { client: api, fetchImpl } = batches(
      { messages: 25, chunks: 60, done: false },
      { messages: 25, chunks: 0, done: false },
      { messages: 0, chunks: 0, done: true }
    )
    const onBatch = vi.fn()
    await expect(rebuildRecallIndex(api, { onBatch })).resolves.toEqual({
      kind: 'stalled',
      messages: 50
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onBatch).toHaveBeenCalledTimes(2)
  })

  it('keeps going on an empty batch that is not done', async () => {
    const { client: api, fetchImpl } = batches(
      { messages: 0, chunks: 0, done: false },
      { messages: 0, chunks: 0, done: true }
    )
    await expect(rebuildRecallIndex(api)).resolves.toEqual({
      kind: 'done',
      messages: 0
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops after the most rounds it allows', async () => {
    const { client: api, fetchImpl } = batches({
      messages: 5,
      chunks: 5,
      done: false
    })
    await expect(rebuildRecallIndex(api, { maxRounds: 3 })).resolves.toEqual({
      kind: 'stopped',
      messages: 15
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('allows 200 rounds by default', () => {
    expect(MAX_REBUILD_ROUNDS).toBe(200)
  })

  it('rejects when a batch fails', async () => {
    const { client: api } = client(() => json({ error: 'Boom' }, 500))
    await expect(rebuildRecallIndex(api)).rejects.toMatchObject({
      status: 500
    })
  })

  it('sends nothing more once the caller aborts between batches', async () => {
    const { client: api, fetchImpl } = batches(
      { messages: 10, chunks: 20, done: false },
      { messages: 0, chunks: 0, done: true }
    )
    const controller = new AbortController()
    const reason = new Error('left')
    const result = rebuildRecallIndex(api, {
      signal: controller.signal,
      onBatch: () => controller.abort(reason)
    })
    await expect(result).rejects.toBe(reason)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts the batch in flight', async () => {
    const { client: api } = client(hang)
    const controller = new AbortController()
    const reason = new Error('left')
    const result = rebuildRecallIndex(api, { signal: controller.signal })
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
  })

  it('gives each batch the timeout', async () => {
    vi.useFakeTimers()
    const { client: api } = client(hang)
    const result = rebuildRecallIndex(api, { timeoutMs: 500 })
    const settled = expect(result).rejects.toMatchObject({
      message: REBUILD_TIMED_OUT
    })
    await vi.advanceTimersByTimeAsync(500)
    await settled
  })
})

describe('categoryLabel', () => {
  it.each([
    ['preference', 'Preference'],
    ['fact', 'Fact'],
    ['interest', 'Interest']
  ])('labels %s as %s', (category, label) => {
    expect(categoryLabel(category)).toBe(label)
  })

  it.each(['hobby', 'toString', 'constructor'])(
    'shows an unknown category (%s) as it is',
    category => {
      expect(categoryLabel(category)).toBe(category)
    }
  )
})

describe('memoryErrorText', () => {
  it.each([401, 403])('says memory is unavailable for a %i', status => {
    expect(memoryErrorText(new ApiError(status, 'Unauthorized'))).toBe(
      MEMORY_UNAVAILABLE
    )
  })

  it('gives any other error’s message', () => {
    expect(memoryErrorText(new ApiError(500, 'Failed to load memory'))).toBe(
      'Failed to load memory'
    )
    expect(memoryErrorText(new Error('Network down'))).toBe('Network down')
    expect(memoryErrorText('odd')).toBe('odd')
  })
})

describe('rebuildErrorText', () => {
  it.each([401, 403])('says memory is unavailable for a %i', status => {
    expect(rebuildErrorText(new ApiError(status, 'Unauthorized'))).toBe(
      MEMORY_UNAVAILABLE
    )
  })

  it('keeps the app’s own network and timeout messages', () => {
    expect(rebuildErrorText(new ApiError(0, NETWORK_ERROR_MESSAGE))).toBe(
      NETWORK_ERROR_MESSAGE
    )
    expect(rebuildErrorText(new ApiError(0, REBUILD_TIMED_OUT))).toBe(
      REBUILD_TIMED_OUT
    )
  })

  it('never shows the server’s text', () => {
    for (const error of [
      new ApiError(500, 'Rebuild failed — see server logs', {
        retryable: true
      }),
      new ApiError(502, 'Bad gateway'),
      new Error('odd'),
      'odd'
    ]) {
      expect(rebuildErrorText(error)).toBe(REBUILD_FAILED)
    }
    expect(REBUILD_FAILED).toBe('Try again later.')
  })
})
