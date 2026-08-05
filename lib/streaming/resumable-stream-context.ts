import { after } from 'next/server'

import type { RedisClientType } from 'redis'
import type { ResumableStreamContext } from 'resumable-stream'
import { createResumableStreamContext } from 'resumable-stream/redis'

// Resumable streams mirror the SSE output to Redis so a turn survives a client
// disconnect (mobile tab backgrounded) and can be reconnected + resumed live on
// return. Requires a REAL Redis with pub/sub — node-redis via LOCAL_REDIS_URL.
// Upstash-REST-only deploys have no persistent pub/sub, so this degrades to
// null and the caller falls back to a plain drain (the §1 foundation still
// guarantees background completion + persistence either way).

// TTL for the active-stream pointer == GENERATION_TIMEOUT_MS (app/api/chat/
// route.ts), so a crashed server never leaves a dangling pointer.
const POINTER_TTL_SECONDS = 300
const pointerKey = (chatId: string) => `ask:chat:${chatId}:activeStream`

interface Resumable {
  context: ResumableStreamContext
  publisher: RedisClientType
}

let resumablePromise: Promise<Resumable | null> | null = null

async function build(): Promise<Resumable | null> {
  const url = process.env.LOCAL_REDIS_URL
  if (!url) return null
  try {
    const { createClient } = await import('redis')
    const publisher = createClient({ url }) as RedisClientType
    publisher.on('error', () => {})
    // node-redis: a subscribed connection can't run normal commands, so pub/sub
    // needs its OWN duplicated connection.
    const subscriber = publisher.duplicate()
    subscriber.on('error', () => {})
    await Promise.all([publisher.connect(), subscriber.connect()])
    const context = createResumableStreamContext({
      keyPrefix: 'ask:resumable',
      waitUntil: (promise: Promise<unknown>) => after(promise),
      publisher,
      subscriber
    })
    return { context, publisher }
  } catch (error) {
    console.warn(
      '[resumable-stream] init failed; resumable streams disabled:',
      error
    )
    return null
  }
}

function getResumable(): Promise<Resumable | null> {
  if (!resumablePromise) resumablePromise = build().catch(() => null)
  return resumablePromise
}

/** The resumable-stream context, or null when Redis pub/sub isn't available. */
export async function getResumableStreamContext(): Promise<ResumableStreamContext | null> {
  return (await getResumable())?.context ?? null
}

/** Record which stream is currently live for a chat (for the GET resume path). */
export async function setActiveStreamId(
  chatId: string,
  streamId: string
): Promise<void> {
  const r = await getResumable()
  if (!r) return
  try {
    await r.publisher.set(pointerKey(chatId), streamId, {
      EX: POINTER_TTL_SECONDS
    })
  } catch {
    /* pointer is best-effort */
  }
}

export async function getActiveStreamId(
  chatId: string
): Promise<string | null> {
  const r = await getResumable()
  if (!r) return null
  try {
    return await r.publisher.get(pointerKey(chatId))
  } catch {
    return null
  }
}

export async function clearActiveStreamId(chatId: string): Promise<void> {
  const r = await getResumable()
  if (!r) return
  try {
    await r.publisher.del(pointerKey(chatId))
  } catch {
    /* best-effort */
  }
}
