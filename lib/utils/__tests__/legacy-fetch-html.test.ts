// @vitest-environment node
import http from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { fetchHtml } from '../legacy-fetch-html'
import { assertUrlAllowed, SsrfBlockedError } from '../ssrf-guard'

// A local server stands in for "the public internet". The guard is injected so
// ONLY this server's origin is exempt; every other hop goes through the real
// assertUrlAllowed.
let server: http.Server
let origin = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>hello</body></html>')
    } else if (path === '/to-page') {
      res.writeHead(302, { location: '/page' })
      res.end()
    } else if (path === '/to-metadata') {
      res.writeHead(302, {
        location: 'http://169.254.169.254/latest/meta-data'
      })
      res.end()
    } else if (path === '/to-lan') {
      res.writeHead(301, { location: 'http://192.168.50.17:3000/' })
      res.end()
    } else if (path === '/loop') {
      res.writeHead(302, { location: '/loop' })
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
})

const guardExceptTestServer = vi.fn(async (url: string) => {
  if (url.startsWith(origin)) return
  await assertUrlAllowed(url)
})

describe('legacy fetchHtml SSRF guard', () => {
  it('refuses a private target outright with the default guard', async () => {
    await expect(fetchHtml(`${origin}/page`)).rejects.toBeInstanceOf(
      SsrfBlockedError
    )
  })

  it('follows a same-origin redirect after checking the target', async () => {
    guardExceptTestServer.mockClear()
    const html = await fetchHtml(`${origin}/to-page`, {
      assertAllowed: guardExceptTestServer
    })
    expect(html).toContain('hello')
    // Checked once per hop: the start URL and the redirect target.
    expect(guardExceptTestServer.mock.calls.map(c => c[0])).toEqual([
      `${origin}/to-page`,
      `${origin}/page`
    ])
  })

  it('refuses a redirect to the cloud metadata address', async () => {
    await expect(
      fetchHtml(`${origin}/to-metadata`, {
        assertAllowed: guardExceptTestServer
      })
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('refuses a redirect into the LAN', async () => {
    await expect(
      fetchHtml(`${origin}/to-lan`, { assertAllowed: guardExceptTestServer })
    ).rejects.toThrow(/private or reserved/)
  })

  it('caps redirect chains instead of recursing forever', async () => {
    await expect(
      fetchHtml(`${origin}/loop`, {
        assertAllowed: guardExceptTestServer,
        maxRedirects: 3
      })
    ).rejects.toThrow(/Too many redirects/)
  })
})
