import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The lib/imagegen collaborators are mocked — this suite exercises the tool's
// orchestration (order, guards, error mapping, selection precedence), not their
// internals.
vi.mock('@/lib/imagegen/budget', () => ({
  checkImageBudget: vi.fn(),
  recordImageGeneration: vi.fn()
}))
vi.mock('@/lib/imagegen/registry', () => ({
  pickPinnedModel: vi.fn(),
  getPremiumModel: vi.fn(),
  resolveImagePool: vi.fn(),
  effectiveImageTask: (prompt: string, task?: string) =>
    /\b(svg|vector)\b/i.test(prompt) ? 'logo-svg' : (task ?? 'general'),
  buildModelInput: vi.fn(),
  IMAGE_TASKS: [
    'photoreal',
    'illustration',
    'design-text',
    'logo-svg',
    'draft-fast',
    'general'
  ]
}))
vi.mock('@/lib/imagegen/rotation', () => ({ nextRotationIndex: vi.fn() }))
vi.mock('@/lib/imagegen/retry-tracker', () => ({ trackRetry: vi.fn() }))
vi.mock('@/lib/imagegen/replicate-client', () => ({
  runReplicatePrediction: vi.fn()
}))
vi.mock('@/lib/imagegen/persist-image', () => ({
  persistGeneratedImage: vi.fn()
}))

// node:fs is mocked so the own-upload branch's readFile is deterministic and
// never touches disk (the brief: "mocking the four lib/imagegen modules + fs").
// Only promises.readFile is exercised by the tool.
const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))
vi.mock('node:fs', () => ({
  default: { promises: { readFile: readFileMock } },
  promises: { readFile: readFileMock }
}))

// resolveUploadUrl (real) lives in transform-file-parts, which imports these DB
// modules at eval time — stub them so this suite pulls in no real DB graph.
vi.mock('@/lib/db/file-actions', () => ({ findFileByObjectKey: vi.fn() }))
vi.mock('@/lib/embeddings/upload-rag', () => ({ queryFileChunks: vi.fn() }))

import { checkImageBudget, recordImageGeneration } from '@/lib/imagegen/budget'
import { persistGeneratedImage } from '@/lib/imagegen/persist-image'
import {
  buildModelInput,
  getPremiumModel,
  pickPinnedModel,
  resolveImagePool
} from '@/lib/imagegen/registry'
import { runReplicatePrediction } from '@/lib/imagegen/replicate-client'
import { trackRetry } from '@/lib/imagegen/retry-tracker'
import { nextRotationIndex } from '@/lib/imagegen/rotation'

import { createGenerateImageTool, isImageGenEnabled } from '../generate-image'

const GENERATE_MODEL = { modelPath: 'black-forest-labs/flux-1.1-pro' } as any
const EDIT_MODEL = { modelPath: 'google/nano-banana' } as any

function allowBudget() {
  vi.mocked(checkImageBudget).mockResolvedValue({
    allowed: true,
    used: 0,
    budget: null
  })
}

function okPrediction() {
  vi.mocked(runReplicatePrediction).mockResolvedValue({
    ok: true,
    outputUrl: 'https://replicate.delivery/x/out.png'
  })
}

function okPersist(publicUrl = '/uploads/u1/generated/c1/123-abcd1234.png') {
  vi.mocked(persistGeneratedImage).mockResolvedValue({
    publicUrl,
    objectKey: publicUrl.replace('/uploads/', '')
  })
}

// A rest param (not a default) so an OMITTED chatId falls back to 'c1' (relied on
// by most cases) while an EXPLICIT `undefined` stays undefined — a plain default
// param can't tell those apart, and the user-scoped-retry-key case needs a
// genuinely absent chatId.
async function run(
  input: { prompt: string; baseImageUrl?: string; aspectRatio?: any },
  userId = 'u1',
  ...chatIdArg: [chatId?: string | undefined]
) {
  const chatId = chatIdArg.length > 0 ? chatIdArg[0] : 'c1'
  const tool = createGenerateImageTool(userId, chatId)
  return tool.execute!(input, {} as any)
}

describe('isImageGenEnabled', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is true only when REPLICATE_API_TOKEN is set', () => {
    vi.stubEnv('REPLICATE_API_TOKEN', '')
    expect(isImageGenEnabled()).toBe(false)
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_secret')
    expect(isImageGenEnabled()).toBe(true)
  })
})

describe('createGenerateImageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(buildModelInput).mockReturnValue({ prompt: 'x' })
    vi.mocked(recordImageGeneration).mockResolvedValue(undefined)

    // Selection defaults: no env pin, no escalation, single-model general pool.
    vi.mocked(pickPinnedModel).mockReturnValue(null)
    vi.mocked(getPremiumModel).mockReturnValue({
      modelPath: 'google/nano-banana-pro'
    } as any)
    vi.mocked(trackRetry).mockResolvedValue({ attempt: 0, escalate: false })
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'generate:general',
      models: [GENERATE_MODEL]
    })
    vi.mocked(nextRotationIndex).mockResolvedValue(0)
  })

  // 1 ── text-to-image happy path ────────────────────────────────────────────
  it('generates from text: rotates the generate pool, persists, and records exactly once', async () => {
    allowBudget()
    okPrediction()
    okPersist('/uploads/u1/generated/c1/123-abcd1234.png')

    const res = await run({ prompt: 'a red fox in snow' })

    expect(res).toEqual({
      imageUrl: '/uploads/u1/generated/c1/123-abcd1234.png',
      prompt: 'a red fox in snow'
    })
    expect(resolveImagePool).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'generate' })
    )
    expect(nextRotationIndex).toHaveBeenCalledWith('generate:general', 1)
    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'black-forest-labs/flux-1.1-pro' })
    )
    expect(persistGeneratedImage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: 'https://replicate.delivery/x/out.png',
        userId: 'u1',
        chatId: 'c1',
        modelPath: 'black-forest-labs/flux-1.1-pro'
      })
    )
    expect(recordImageGeneration).toHaveBeenCalledTimes(1)
    // No baseImage → never touched the upload store.
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('includes aspectRatio in the success object only when provided', async () => {
    allowBudget()
    okPrediction()
    okPersist()

    const res = (await run({ prompt: 'a fox', aspectRatio: '16:9' })) as any
    expect(res.aspectRatio).toBe('16:9')
    expect(buildModelInput).toHaveBeenCalledWith(
      GENERATE_MODEL,
      expect.objectContaining({ prompt: 'a fox', aspectRatio: '16:9' })
    )
  })

  // 2 ── edit path with a data URI ───────────────────────────────────────────
  it('edits an own upload: reads the file, passes a data URI, uses the edit pool', async () => {
    allowBudget()
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'edit:general',
      models: [EDIT_MODEL]
    })
    readFileMock.mockResolvedValue(Buffer.from([1, 2, 3]))
    okPrediction()
    okPersist('/uploads/u1/generated/c1/999-edcba987.png')

    const res = (await run({
      prompt: 'make it night',
      baseImageUrl: '/uploads/u1/chats/c1/1-a.png'
    })) as any

    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringContaining('u1/chats/c1/1-a.png')
    )
    expect(buildModelInput).toHaveBeenCalledWith(
      EDIT_MODEL,
      expect.objectContaining({
        prompt: 'make it night',
        baseImage: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`
      })
    )
    expect((res as any).modelId).toBeUndefined()
    expect(res.imageUrl).toBe('/uploads/u1/generated/c1/999-edcba987.png')
  })

  // 3 ── foreign-user upload rejected before the prediction ───────────────────
  it("rejects another user's upload before any read or prediction", async () => {
    allowBudget()

    const res = (await run({
      prompt: 'edit this',
      baseImageUrl: '/uploads/OTHER/chats/c1/1-a.png'
    })) as any

    expect(res).toMatchObject({ error: expect.any(String) })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(runReplicatePrediction).not.toHaveBeenCalled()
    expect(recordImageGeneration).not.toHaveBeenCalled()
  })

  // 4 ── external https passthrough ──────────────────────────────────────────
  it('passes an external https base image through verbatim without reading or fetching it', async () => {
    allowBudget()
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'edit:general',
      models: [EDIT_MODEL]
    })
    okPrediction()
    okPersist()

    await run({
      prompt: 'restyle',
      baseImageUrl: 'https://example.com/pic.jpg'
    })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(resolveImagePool).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'edit' })
    )
    expect(buildModelInput).toHaveBeenCalledWith(
      EDIT_MODEL,
      expect.objectContaining({ baseImage: 'https://example.com/pic.jpg' })
    )
  })

  // 5 ── non-https external URL rejected ─────────────────────────────────────
  it('rejects a non-https (http) base image URL before the prediction', async () => {
    allowBudget()

    const res = (await run({
      prompt: 'edit this',
      baseImageUrl: 'http://example.com/pic.jpg'
    })) as any

    expect(res).toMatchObject({ error: expect.any(String) })
    expect(runReplicatePrediction).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  // 6 ── budget exhausted ────────────────────────────────────────────────────
  it('returns a budget error and never calls the prediction when the budget is exhausted', async () => {
    vi.mocked(checkImageBudget).mockResolvedValue({
      allowed: false,
      used: 100,
      budget: 100
    })

    const res = (await run({ prompt: 'a fox' })) as any

    expect(res.error).toMatch(/budget/i)
    expect(runReplicatePrediction).not.toHaveBeenCalled()
    expect(recordImageGeneration).not.toHaveBeenCalled()
  })

  // 7 ── billing failure maps to a user message and records nothing ───────────
  it('maps a billing failure to a credit message and does NOT record or persist', async () => {
    allowBudget()
    vi.mocked(runReplicatePrediction).mockResolvedValue({
      ok: false,
      errorClass: 'billing',
      message: 'Payment Required'
    })

    const res = await run({ prompt: 'a fox' })

    expect(res).toEqual({ error: 'The Replicate account is out of credit.' })
    expect(persistGeneratedImage).not.toHaveBeenCalled()
    expect(recordImageGeneration).not.toHaveBeenCalled()
  })

  // 8 ── selection precedence ────────────────────────────────────────────────
  it('an env pin bypasses rotation entirely', async () => {
    allowBudget()
    vi.mocked(pickPinnedModel).mockReturnValue({
      modelPath: 'pinned/model'
    } as any)
    okPrediction()
    okPersist()

    await run({ prompt: 'a fox' })

    expect(resolveImagePool).not.toHaveBeenCalled()
    expect(nextRotationIndex).not.toHaveBeenCalled()
    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'pinned/model' })
    )
  })

  it('quality premium uses the premium model and still records the attempt', async () => {
    allowBudget()
    okPrediction()
    okPersist()

    await run({ prompt: 'a fox', quality: 'premium' } as any)

    expect(trackRetry).toHaveBeenCalledWith('c1', false)
    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'google/nano-banana-pro' })
    )
    expect(resolveImagePool).not.toHaveBeenCalled()
  })

  it('the 4th consecutive retry escalates to premium', async () => {
    allowBudget()
    vi.mocked(trackRetry).mockResolvedValue({ attempt: 4, escalate: true })
    okPrediction()
    okPersist()

    await run({ prompt: 'a fox', isRetry: true } as any)

    expect(trackRetry).toHaveBeenCalledWith('c1', true)
    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'google/nano-banana-pro' })
    )
  })

  it('logo-svg requests never go premium, even on escalation or explicit quality', async () => {
    allowBudget()
    vi.mocked(trackRetry).mockResolvedValue({ attempt: 4, escalate: true })
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'generate:logo-svg',
      models: [{ modelPath: 'recraft-ai/recraft-v4.1-svg' } as any]
    })
    okPrediction()
    okPersist()

    await run({ prompt: 'an svg logo', quality: 'premium', isRetry: true } as any)

    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'recraft-ai/recraft-v4.1-svg' })
    )
  })

  it('rotation picks the model at the returned index', async () => {
    allowBudget()
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'generate:general',
      models: [GENERATE_MODEL, { modelPath: 'second/model' } as any]
    })
    vi.mocked(nextRotationIndex).mockResolvedValue(1)
    okPrediction()
    okPersist()

    await run({ prompt: 'a fox' })

    expect(nextRotationIndex).toHaveBeenCalledWith('generate:general', 2)
    expect(runReplicatePrediction).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: 'second/model' })
    )
  })

  it('errors cleanly when the pool resolves empty', async () => {
    allowBudget()
    vi.mocked(resolveImagePool).mockReturnValue({
      poolKey: 'generate:general',
      models: []
    })

    const res = (await run({ prompt: 'a fox' })) as any

    expect(res.error).toMatch(/no image model/i)
    expect(runReplicatePrediction).not.toHaveBeenCalled()
  })

  it('falls back to a user-scoped retry key when there is no chatId', async () => {
    allowBudget()
    okPrediction()
    okPersist()

    await run({ prompt: 'a fox' }, 'u1', undefined)

    expect(trackRetry).toHaveBeenCalledWith('user:u1', false)
  })
})
