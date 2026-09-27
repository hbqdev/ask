// @vitest-environment node
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLocalRedisConnector,
  createResilientRedisClient,
  type LocalRedisClient,
  localRedisReconnectDelayMs,
  RedisCommandTimeoutError,
  withRedisTimeout
} from '../local-redis'

// Regression for 2026-09-27: the weekly image update recreated the redis
// sidecar, every module-level client built with a bare createClient() threw
// "Socket closed unexpectedly" as an uncaughtException (no 'error' listener),
// never reconnected, and its offline queue held the advanced-search route's
// cache GET forever — so the route never sent headers and every first search
// hung for 300s.

/** Minimal stand-in for a node-redis client, driven by the test. */
class FakeClient extends EventEmitter {
  isOpen = false
  isReady = false
  options: Record<string, unknown>
  connectImpl: () => Promise<void>
  get = vi.fn(async (_key: string): Promise<string | null> => 'v')
  disconnect = vi.fn(async () => {
    this.isOpen = false
    this.isReady = false
  })
  constructor(
    options: Record<string, unknown>,
    connectImpl?: () => Promise<void>
  ) {
    super()
    this.options = options
    this.connectImpl =
      connectImpl ??
      (async () => {
        this.isReady = true
        this.emit('ready')
      })
  }
  connect() {
    this.isOpen = true
    return this.connectImpl()
  }
}

function fakeFactory(connectImpl?: (c: FakeClient) => Promise<void>) {
  const made: FakeClient[] = []
  const create = (options: Record<string, unknown>) => {
    const c: FakeClient = new FakeClient(
      options,
      connectImpl ? () => connectImpl(c) : undefined
    )
    made.push(c)
    return c as unknown as LocalRedisClient
  }
  return { made, create: create as never }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('createResilientRedisClient', () => {
  it('disables the offline queue and bounds connect + reconnect', () => {
    const { made, create } = fakeFactory()
    createResilientRedisClient('t', 'redis://x:6379', create)
    const opts = made[0].options as {
      url: string
      disableOfflineQueue: boolean
      socket: {
        connectTimeout: number
        reconnectStrategy: (n: number) => number
      }
    }
    expect(opts.url).toBe('redis://x:6379')
    expect(opts.disableOfflineQueue).toBe(true)
    expect(opts.socket.connectTimeout).toBeGreaterThan(0)
    expect(opts.socket.connectTimeout).toBeLessThanOrEqual(5000)
    // A number (not false/Error) keeps node-redis reconnecting, capped.
    expect(opts.socket.reconnectStrategy(1)).toBe(200)
    expect(opts.socket.reconnectStrategy(1000)).toBe(2000)
  })

  it('registers an error listener, so an error event never throws', () => {
    const { made, create } = fakeFactory()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    createResilientRedisClient('t', 'redis://x', create)
    expect(made[0].listenerCount('error')).toBeGreaterThan(0)
    // Without a listener EventEmitter throws here — the 2026-09-27 crash path.
    expect(() =>
      made[0].emit('error', new Error('Socket closed unexpectedly'))
    ).not.toThrow()
  })

  it('logs once per state change, not once per retry tick', () => {
    const { made, create } = fakeFactory()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    createResilientRedisClient('t', 'redis://x', create)
    const c = made[0]
    c.emit('error', new Error('Socket closed unexpectedly'))
    c.emit('error', new Error('connect ECONNREFUSED'))
    c.emit('error', new Error('connect ECONNREFUSED'))
    c.emit('error', new Error('connect ECONNREFUSED'))
    expect(warn).toHaveBeenCalledTimes(2)
    c.emit('ready')
    expect(log).toHaveBeenCalledWith('[redis:t] reconnected')
    c.emit('error', new Error('connect ECONNREFUSED'))
    expect(warn).toHaveBeenCalledTimes(3)
  })
})

describe('localRedisReconnectDelayMs', () => {
  it('backs off linearly and caps at 2s', () => {
    expect(localRedisReconnectDelayMs(0)).toBe(0)
    expect(localRedisReconnectDelayMs(3)).toBe(600)
    expect(localRedisReconnectDelayMs(50)).toBe(2000)
  })
})

describe('withRedisTimeout', () => {
  it('passes a prompt result through', async () => {
    await expect(withRedisTimeout(Promise.resolve('ok'), 50)).resolves.toBe(
      'ok'
    )
  })

  it('rejects a command that never settles', async () => {
    const started = Date.now()
    await expect(
      withRedisTimeout(new Promise(() => {}), 30)
    ).rejects.toBeInstanceOf(RedisCommandTimeoutError)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('observes a late rejection so it never becomes unhandled', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    let rejectLate!: (e: Error) => void
    const late = new Promise((_r, reject) => (rejectLate = reject))
    await expect(withRedisTimeout(late, 10)).rejects.toBeInstanceOf(
      RedisCommandTimeoutError
    )
    rejectLate(new Error('late'))
    await new Promise(r => setTimeout(r, 20))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe('createLocalRedisConnector', () => {
  it('returns a ready client whose commands pass through', async () => {
    const { made, create } = fakeFactory()
    const conn = createLocalRedisConnector('t', { create })
    const client = await conn.get()
    expect(client).not.toBeNull()
    await expect(client!.get('k')).resolves.toBe('v')
    expect(made[0].get).toHaveBeenCalledWith('k')
    // Cached: the same underlying client on the next call.
    await conn.get()
    expect(made).toHaveLength(1)
  })

  it('a command that hangs rejects within the command timeout (= a miss)', async () => {
    const { made, create } = fakeFactory()
    const conn = createLocalRedisConnector('t', {
      create,
      commandTimeoutMs: 30
    })
    const client = await conn.get()
    made[0].get.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    await expect(client!.get('k')).rejects.toBeInstanceOf(
      RedisCommandTimeoutError
    )
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('returns null — immediately — while the client is reconnecting', async () => {
    const { made, create } = fakeFactory()
    const conn = createLocalRedisConnector('t', { create })
    await conn.get()
    made[0].isReady = false // socket dropped; node-redis is reconnecting
    const started = Date.now()
    await expect(conn.get()).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(100)
    made[0].isReady = true // reconnected: usable again, no rebuild needed
    await expect(conn.get()).resolves.not.toBeNull()
    expect(made).toHaveLength(1)
  })

  it('waits at most connectWaitMs for a first connect that never finishes', async () => {
    // With a reconnectStrategy, node-redis connect() keeps retrying and never
    // settles while Redis is down; the wait must be bounded, and only once.
    const { made, create } = fakeFactory(() => new Promise(() => {}))
    const conn = createLocalRedisConnector('t', { create, connectWaitMs: 50 })
    const started = Date.now()
    await expect(conn.get()).resolves.toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
    const again = Date.now()
    await expect(conn.get()).resolves.toBeNull()
    expect(Date.now() - again).toBeLessThan(30)
    // Still the same client, reconnecting in the background.
    expect(made).toHaveLength(1)
  })

  it('drops a closed client and rebuilds on the next call', async () => {
    const { made, create } = fakeFactory()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conn = createLocalRedisConnector('t', { create })
    await conn.get()
    made[0].isOpen = false // quit / gave up: it will never come back
    made[0].isReady = false
    const client = await conn.get()
    expect(made).toHaveLength(2)
    expect(client).not.toBeNull()
    await expect(client!.get('k')).resolves.toBe('v')
    expect(made[1].get).toHaveBeenCalled()
  })

  it('drops a connect that rejects, and retries on the next call', async () => {
    let calls = 0
    const { made, create } = fakeFactory(async c => {
      calls += 1
      if (calls === 1) throw new Error('NOAUTH')
      c.isReady = true
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conn = createLocalRedisConnector('t', { create })
    await expect(conn.get()).resolves.toBeNull()
    await expect(conn.get()).resolves.not.toBeNull()
    expect(made).toHaveLength(2)
  })

  it('tears down a client that keeps timing out (half-open socket)', async () => {
    const { made, create } = fakeFactory()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conn = createLocalRedisConnector('t', {
      create,
      commandTimeoutMs: 10,
      timeoutsBeforeRebuild: 2
    })
    const client = await conn.get()
    made[0].get.mockImplementation(() => new Promise(() => {}))
    await expect(client!.get('a')).rejects.toBeInstanceOf(
      RedisCommandTimeoutError
    )
    expect(made[0].disconnect).not.toHaveBeenCalled()
    await expect(client!.get('b')).rejects.toBeInstanceOf(
      RedisCommandTimeoutError
    )
    expect(made[0].disconnect).toHaveBeenCalled()
    await conn.get()
    expect(made).toHaveLength(2)
  })

  it('a success resets the consecutive-timeout count', async () => {
    const { made, create } = fakeFactory()
    const conn = createLocalRedisConnector('t', {
      create,
      commandTimeoutMs: 10,
      timeoutsBeforeRebuild: 2
    })
    const client = await conn.get()
    made[0].get.mockImplementationOnce(() => new Promise(() => {}))
    await expect(client!.get('a')).rejects.toThrow()
    await expect(client!.get('b')).resolves.toBe('v')
    made[0].get.mockImplementationOnce(() => new Promise(() => {}))
    await expect(client!.get('c')).rejects.toThrow()
    expect(made[0].disconnect).not.toHaveBeenCalled()
  })

  it('never throws out of get() even if building the client throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const conn = createLocalRedisConnector('t', {
      create: (() => {
        throw new TypeError('Invalid URL')
      }) as never
    })
    await expect(conn.get()).resolves.toBeNull()
  })
})

// End to end with the REAL node-redis client against a tiny RESP server that
// is "restarted" mid-test — the exact 2026-09-27 sequence. Before the fix this
// raised an uncaughtException (which would fail this run) and every later
// command queued forever.
describe('real node-redis through a Redis restart', () => {
  type FakeServer = { server: net.Server; sockets: Set<net.Socket> }

  function reply(args: string[]): string {
    const cmd = (args[0] ?? '').toUpperCase()
    if (cmd === 'PING') return '+PONG\r\n'
    if (cmd === 'GET') return '$-1\r\n'
    return '+OK\r\n'
  }

  // Parses RESP arrays of bulk strings (all node-redis sends) and answers each.
  function startServer(port = 0): Promise<FakeServer> {
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buf = ''
      socket.on('data', chunk => {
        buf += chunk.toString('latin1')
        for (;;) {
          if (!buf.startsWith('*')) return
          const lines = buf.split('\r\n')
          const n = parseInt(lines[0].slice(1), 10)
          if (lines.length < 1 + n * 2 + 1) return
          const args: string[] = []
          for (let i = 0; i < n; i++) args.push(lines[2 + i * 2])
          const consumed = lines.slice(0, 1 + n * 2).join('\r\n').length + 2
          buf = buf.slice(consumed)
          socket.write(reply(args))
        }
      })
    })
    return new Promise(resolve =>
      server.listen(port, '127.0.0.1', () => resolve({ server, sockets }))
    )
  }

  function stopServer({ server, sockets }: FakeServer): Promise<void> {
    for (const s of sockets) s.destroy()
    return new Promise(resolve => server.close(() => resolve()))
  }

  async function waitFor<T>(
    fn: () => Promise<T | null>,
    ms: number
  ): Promise<T | null> {
    const until = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v || Date.now() > until) return v
      await new Promise(r => setTimeout(r, 50))
    }
  }

  it('fails fast while Redis is gone and reconnects by itself', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)

    let srv = await startServer()
    const port = (srv.server.address() as net.AddressInfo).port
    const conn = createLocalRedisConnector('e2e', {
      url: () => `redis://127.0.0.1:${port}`
    })
    try {
      const client = await conn.get()
      expect(client).not.toBeNull()
      await expect(client!.get('k')).resolves.toBeNull()

      // "docker compose up -d --force-recreate redis": the socket dies.
      await stopServer(srv)
      await new Promise(r => setTimeout(r, 50))

      // No hang: the route's cache GET now fails in well under a second
      // (it used to queue forever) and get() reports Redis as unavailable.
      const started = Date.now()
      await expect(client!.get('k')).rejects.toThrow()
      await expect(conn.get()).resolves.toBeNull()
      expect(Date.now() - started).toBeLessThan(1000)

      // Redis comes back on the same address; the client recovers unaided.
      srv = await startServer(port)
      const back = await waitFor(() => conn.get(), 5000)
      expect(back).not.toBeNull()
      await expect(back!.get('k')).resolves.toBeNull()
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.off('uncaughtException', uncaught)
      conn.reset()
      await stopServer(srv)
    }
  }, 15_000)
})
