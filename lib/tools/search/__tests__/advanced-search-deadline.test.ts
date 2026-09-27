// @vitest-environment node
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  advancedSearchHeadersTimeoutMs,
  AdvancedSearchTimeoutError,
  advancedSearchTimeoutMs,
  createAdvancedSearchDeadline,
  DEFAULT_ADVANCED_SEARCH_HEADERS_TIMEOUT_MS,
  DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS
} from '../advanced-search-deadline'

// A real HTTP server and the real fetch, because the property that matters is
// how undici behaves: on 2026-09-27 the route sent no headers and fetch sat
// for 300s (UND_ERR_HEADERS_TIMEOUT).
let server: http.Server
let base = ''
const open = new Set<http.ServerResponse>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    if (req.url === '/silent') return // never answers: the incident
    if (req.url === '/stall-after-preview') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'preview', results: [] })}\n`)
      return // final line never comes
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const res of open) res.destroy()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
})

afterEach(() => {
  delete process.env.ADVANCED_SEARCH_TIMEOUT_MS
  delete process.env.ADVANCED_SEARCH_HEADERS_TIMEOUT_MS
})

describe('createAdvancedSearchDeadline', () => {
  it('aborts a route that never sends headers, within the headers limit', async () => {
    const d = createAdvancedSearchDeadline({ totalMs: 5000, headersMs: 100 })
    const started = Date.now()
    try {
      await expect(
        fetch(`${base}/silent`, { signal: d.signal })
      ).rejects.toBeTruthy()
    } finally {
      d.clear()
    }
    expect(Date.now() - started).toBeLessThan(2000)
    const t = d.timedOut()
    expect(t).toBeInstanceOf(AdvancedSearchTimeoutError)
    expect(t?.phase).toBe('headers')
    expect(t?.limitMs).toBe(100)
  })

  it('bounds the streamed body with the total limit once headers arrived', async () => {
    const d = createAdvancedSearchDeadline({ totalMs: 300, headersMs: 100 })
    const started = Date.now()
    try {
      const res = await fetch(`${base}/stall-after-preview`, {
        signal: d.signal
      })
      d.headersReceived()
      // The headers clock is stopped: reading past 100ms must not trip it.
      await expect(res.text()).rejects.toBeTruthy()
    } finally {
      d.clear()
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect(d.timedOut()?.phase).toBe('total')
  })

  it('a turn abort cancels the call but is NOT reported as a timeout', async () => {
    const turn = new AbortController()
    const d = createAdvancedSearchDeadline({
      turnSignal: turn.signal,
      totalMs: 5000,
      headersMs: 5000
    })
    setTimeout(() => turn.abort(new Error('user stopped')), 50)
    try {
      await expect(
        fetch(`${base}/silent`, { signal: d.signal })
      ).rejects.toBeTruthy()
    } finally {
      d.clear()
    }
    expect(d.timedOut()).toBeNull()
  })

  it('an already-aborted turn signal aborts immediately', () => {
    const turn = new AbortController()
    turn.abort()
    const d = createAdvancedSearchDeadline({
      turnSignal: turn.signal,
      totalMs: 5000
    })
    expect(d.signal.aborted).toBe(true)
    expect(d.timedOut()).toBeNull()
    d.clear()
  })

  it('a healthy call is untouched, and clear() stops both clocks', async () => {
    const d = createAdvancedSearchDeadline({ totalMs: 80, headersMs: 40 })
    const res = await fetch(`${base}/ok`, { signal: d.signal })
    d.headersReceived()
    await expect(res.json()).resolves.toEqual({ ok: true })
    d.clear()
    await new Promise(r => setTimeout(r, 120))
    expect(d.signal.aborted).toBe(false)
    expect(d.timedOut()).toBeNull()
  })

  it('headersMs 0 disables the headers clock (non-stream mode)', async () => {
    const d = createAdvancedSearchDeadline({ totalMs: 150, headersMs: 0 })
    try {
      await expect(
        fetch(`${base}/silent`, { signal: d.signal })
      ).rejects.toBeTruthy()
    } finally {
      d.clear()
    }
    expect(d.timedOut()?.phase).toBe('total')
  })
})

describe('advanced-search timeout env', () => {
  it('defaults never cut a healthy quality search (measured max ~91s)', () => {
    expect(advancedSearchTimeoutMs()).toBe(DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS)
    expect(DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS).toBeGreaterThan(91_000)
    expect(advancedSearchHeadersTimeoutMs()).toBe(
      DEFAULT_ADVANCED_SEARCH_HEADERS_TIMEOUT_MS
    )
  })

  it('honours positive overrides and ignores garbage', () => {
    process.env.ADVANCED_SEARCH_TIMEOUT_MS = '60000'
    process.env.ADVANCED_SEARCH_HEADERS_TIMEOUT_MS = '5000'
    expect(advancedSearchTimeoutMs()).toBe(60_000)
    expect(advancedSearchHeadersTimeoutMs()).toBe(5_000)
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env.ADVANCED_SEARCH_TIMEOUT_MS = bad
      expect(advancedSearchTimeoutMs()).toBe(DEFAULT_ADVANCED_SEARCH_TIMEOUT_MS)
    }
  })
})
