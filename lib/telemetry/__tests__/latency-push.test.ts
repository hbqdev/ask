import { describe, expect, it } from 'vitest'

import { createRedisPush, LATENCY_CAP, LATENCY_KEY } from '../latency-store'

describe('createRedisPush', () => {
  it('appends the line to the capped list (node-redis dialect)', async () => {
    const calls: string[] = []
    const client = {
      lPush: async (key: string, value: string) => {
        calls.push(`lPush ${key} ${value}`)
      },
      lTrim: async (key: string, start: number, stop: number) => {
        calls.push(`lTrim ${key} ${start} ${stop}`)
      }
    }
    const push = createRedisPush(async () => client)

    await push('[latency] {"total_ms":12}')

    expect(calls).toEqual([
      `lPush ${LATENCY_KEY} [latency] {"total_ms":12}`,
      `lTrim ${LATENCY_KEY} 0 ${LATENCY_CAP - 1}`
    ])
  })

  it('appends via the lowercase Upstash dialect when that is what the client offers', async () => {
    const calls: string[] = []
    const client = {
      lpush: async (key: string, value: string) => {
        calls.push(`lpush ${key} ${value}`)
      },
      ltrim: async (key: string, start: number, stop: number) => {
        calls.push(`ltrim ${key} ${start} ${stop}`)
      }
    }
    const push = createRedisPush(async () => client)

    await push('[latency] {}')

    expect(calls).toEqual([
      `lpush ${LATENCY_KEY} [latency] {}`,
      `ltrim ${LATENCY_KEY} 0 ${LATENCY_CAP - 1}`
    ])
  })

  it('no-ops when no redis client is available', async () => {
    const push = createRedisPush(async () => null)
    await expect(push('[latency] {}')).resolves.toBeUndefined()
  })
})
