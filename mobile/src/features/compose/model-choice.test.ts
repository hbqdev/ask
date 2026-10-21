import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import {
  getModelChoice,
  modelListLoaded,
  modelListMark,
  pickModel,
  resetModelChoice,
  subscribeModelChoice
} from '@/features/compose/model-choice'
import type { Model } from '@/lib/types/models'

const BASE = 'https://ask.test.invalid'

const KIMI: Model = {
  id: 'kimi',
  name: 'Kimi',
  provider: 'Cloud',
  providerId: 'cloud'
}

/** A client whose saves answer when the test says so. */
function savingClient() {
  const answers: Array<(res: Response) => void> = []
  const fetchImpl = vi.fn(
    () => new Promise<Response>(resolve => answers.push(resolve))
  )
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl
  })
  return { client, fetchImpl, answers }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const settled = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  resetModelChoice()
})

describe('model choice', () => {
  it('a list load shows the server’s pick and tells subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeModelChoice(listener)
    modelListLoaded('ollama:qwen3', modelListMark())
    expect(getModelChoice()).toEqual({
      selected: 'ollama:qwen3',
      saveFailed: false
    })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    modelListLoaded('cloud:kimi', modelListMark())
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a list load that started before a pick', async () => {
    const { client, answers } = savingClient()
    modelListLoaded('ollama:qwen3', modelListMark())
    const mark = modelListMark()
    pickModel(client, KIMI)
    await settled()
    answers[0](json({ ok: true, selectedModelKey: 'cloud:kimi' }))
    await settled()
    modelListLoaded('ollama:qwen3', mark)
    expect(getModelChoice().selected).toBe('cloud:kimi')
  })

  it('ignores a list load while a save is in flight', () => {
    const { client } = savingClient()
    pickModel(client, KIMI)
    modelListLoaded('ollama:qwen3', modelListMark())
    expect(getModelChoice().selected).toBe('cloud:kimi')
  })

  it('a pick of the model already checked sends nothing', () => {
    const { client, fetchImpl } = savingClient()
    modelListLoaded('cloud:kimi', modelListMark())
    pickModel(client, KIMI)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['saved', json({ ok: true, selectedModelKey: 'cloud:kimi' })],
    ['failed', json({ error: 'Invalid model' }, 400)]
  ])('a save %s after a reset changes nothing', async (_name, res) => {
    const { client, answers } = savingClient()
    pickModel(client, KIMI)
    const listener = vi.fn()
    const unsubscribe = subscribeModelChoice(listener)
    resetModelChoice()
    expect(getModelChoice()).toEqual({ selected: '', saveFailed: false })
    listener.mockClear()
    await settled()
    answers[0](res)
    await settled()
    expect(listener).not.toHaveBeenCalled()
    expect(getModelChoice()).toEqual({ selected: '', saveFailed: false })
    unsubscribe()
  })
})
