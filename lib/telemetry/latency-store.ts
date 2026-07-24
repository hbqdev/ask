// Durable sink for the per-turn [latency] lines.
//
// The lines go to stdout, but Docker's default json-file log driver keeps them
// per-container — every `up -d --build` recreates the container and wipes the
// history. Since prod is rebuilt on every push, that left us with a handful of
// samples and no way to compare a change against a baseline. This mirrors each
// line into Redis (which survives rebuilds) so latency history accumulates
// across deploys.
//
// Telemetry must never break a turn: the console write happens first, and the
// durable write is fire-and-forget with every failure swallowed.

/** Redis list holding the raw per-turn lines, newest first. */
export const LATENCY_KEY = 'latency:log'
/** Keep the last N turns — bounded so telemetry can never grow unbounded. */
export const LATENCY_CAP = 5000

// node-redis (local, what prod uses) exposes lPush/lTrim; Upstash exposes the
// lowercase pair. The advanced-search route already straddles both dialects,
// so match that rather than assuming one deployment shape.
type ListClient = {
  lPush?: (key: string, value: string) => unknown
  lTrim?: (key: string, start: number, stop: number) => unknown
  lpush?: (key: string, value: string) => unknown
  ltrim?: (key: string, start: number, stop: number) => unknown
}

export function createRedisPush(
  getClient: () => Promise<ListClient | null>
): (line: string) => Promise<void> {
  return async line => {
    const client = await getClient()
    if (!client) return
    const push = client.lPush ?? client.lpush
    const trim = client.lTrim ?? client.ltrim
    if (!push || !trim) return
    await push.call(client, LATENCY_KEY, line)
    await trim.call(client, LATENCY_KEY, 0, LATENCY_CAP - 1)
  }
}

type Deps = {
  log: (line: string) => void
  push: (line: string) => unknown
}

export function createDurableSink(deps: Deps): (line: string) => void {
  return line => {
    deps.log(line)
    try {
      Promise.resolve(deps.push(line)).catch(() => {})
    } catch {
      // A synchronous failure in the durable store is still just telemetry.
    }
  }
}

// Lazily-connected client, mirroring the dual-dialect handling the
// advanced-search route already does. Connection failures resolve to null so
// telemetry degrades to stdout-only rather than retrying on every turn.
let clientPromise: Promise<ListClient | null> | null = null

async function connect(): Promise<ListClient | null> {
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN
  if (upstashUrl && upstashToken) {
    const { Redis } = await import('@upstash/redis')
    return new Redis({ url: upstashUrl, token: upstashToken }) as ListClient
  }

  const localUrl = process.env.LOCAL_REDIS_URL
  if (!localUrl) return null
  const { createClient } = await import('redis')
  const client = createClient({ url: localUrl })
  client.on('error', () => {})
  await client.connect()
  return client as unknown as ListClient
}

export function getLatencyRedis(): Promise<ListClient | null> {
  if (!clientPromise) clientPromise = connect().catch(() => null)
  return clientPromise
}

/** The app-wide sink: stdout for live tailing, Redis so history survives deploys. */
export const durableLatencySink = createDurableSink({
  log: line => console.log(line),
  push: createRedisPush(getLatencyRedis)
})
