import { describe, expect, it, vi } from 'vitest'

import {
  assertUrlAllowed,
  SsrfBlockedError,
  staticBlockReason
} from '../ssrf-guard'

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }))
vi.mock('dns/promises', () => ({
  lookup: lookupMock,
  default: { lookup: lookupMock }
}))

describe('staticBlockReason — schemes', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://x',
    'data:text/plain,hi',
    'ftp://x'
  ])('blocks %s', url => {
    expect(staticBlockReason(url)).toMatch(/scheme/)
  })

  it('allows http and https', () => {
    expect(staticBlockReason('http://example.com')).toBeNull()
    expect(staticBlockReason('https://example.com/path?q=1')).toBeNull()
  })

  it('blocks a malformed URL', () => {
    expect(staticBlockReason('not a url')).toBe('malformed URL')
  })
})

describe('staticBlockReason — literal internal targets', () => {
  it.each([
    'http://127.0.0.1/',
    'http://127.9.9.9/',
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://100.64.0.1/', // CGNAT
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', // v4-mapped loopback
    'http://[fd00::1]/', // unique-local
    'http://[fe80::1]/', // link-local
    'http://localhost/',
    'http://foo.localhost/',
    'http://metadata.google.internal/'
  ])('blocks %s', url => {
    expect(staticBlockReason(url)).not.toBeNull()
  })

  it('does not block a public IP or hostname', () => {
    expect(staticBlockReason('http://8.8.8.8/')).toBeNull()
    expect(staticBlockReason('http://1.1.1.1/')).toBeNull()
    expect(staticBlockReason('https://github.com/')).toBeNull()
    // 172.15 and 172.32 are OUTSIDE the private 172.16/12 block
    expect(staticBlockReason('http://172.15.0.1/')).toBeNull()
    expect(staticBlockReason('http://172.32.0.1/')).toBeNull()
    // 100.63 and 100.128 are outside CGNAT 100.64/10
    expect(staticBlockReason('http://100.63.255.255/')).toBeNull()
  })
})

describe('assertUrlAllowed', () => {
  it('throws for a literal private IP without any DNS call', async () => {
    await expect(
      assertUrlAllowed('http://169.254.169.254/latest/meta-data/')
    ).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('blocks a public hostname that RESOLVES to a private address (rebinding)', async () => {
    // The exploited internal docker name is the real-world instance of this:
    // in-container it resolves to a private docker IP.
    lookupMock.mockResolvedValueOnce([
      { address: '172.19.0.7', family: 4 }
    ] as never)

    await expect(
      assertUrlAllowed('http://ask-searxng-admin-feature:8080/')
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('allows a hostname that resolves to public space', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 }
    ] as never)

    await expect(
      assertUrlAllowed('https://example.com/')
    ).resolves.toBeUndefined()
  })

  it('allows a host whose DNS fails, rather than hard-blocking a transient hiccup', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'))

    await expect(
      assertUrlAllowed('https://momentarily-down.example/')
    ).resolves.toBeUndefined()
  })

  it('blocks when ANY resolved address is private, even if others are public', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ] as never)

    await expect(
      assertUrlAllowed('https://rebind.example/')
    ).rejects.toBeInstanceOf(SsrfBlockedError)
  })

  it('allows (does not hang) when the DNS lookup itself never resolves', async () => {
    // A resolver that hangs must not tie the request up: the guard bounds its
    // own lookup and falls through to allow.
    lookupMock.mockImplementationOnce(
      () => new Promise(() => {}) as never // never settles
    )

    await expect(
      assertUrlAllowed('https://slow-resolver.example/')
    ).resolves.toBeUndefined()
  }, 10000)
})
