import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The four lib/imagegen collaborators are mocked — this suite exercises the
// tool's orchestration (order, guards, error mapping), not their internals.
vi.mock('@/lib/imagegen/budget', () => ({
  checkImageBudget: vi.fn(),
  recordImageGeneration: vi.fn()
}))
vi.mock('@/lib/imagegen/registry', () => ({
  getImageModel: vi.fn(),
  buildModelInput: vi.fn()
}))
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
import { buildModelInput, getImageModel } from '@/lib/imagegen/registry'
import { runReplicatePrediction } from '@/lib/imagegen/replicate-client'

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

async function run(
  input: { prompt: string; baseImageUrl?: string; aspectRatio?: any },
  userId = 'u1',
  chatId: string | undefined = 'c1'
) {
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
  })

  // 1 ── text-to-image happy path ────────────────────────────────────────────
  it('generates from text: uses the generate model, persists, and records exactly once', async () => {
    allowBudget()
    vi.mocked(getImageModel).mockReturnValue(GENERATE_MODEL)
    okPrediction()
    okPersist('/uploads/u1/generated/c1/123-abcd1234.png')

    const res = await run({ prompt: 'a red fox in snow' })

    expect(res).toEqual({
      imageUrl: '/uploads/u1/generated/c1/123-abcd1234.png',
      modelId: 'black-forest-labs/flux-1.1-pro',
      prompt: 'a red fox in snow'
    })
    expect(getImageModel).toHaveBeenCalledWith('generate')
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
    vi.mocked(getImageModel).mockReturnValue(GENERATE_MODEL)
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
  it('edits an own upload: reads the file, passes a data URI, uses the edit model', async () => {
    allowBudget()
    vi.mocked(getImageModel).mockReturnValue(EDIT_MODEL)
    readFileMock.mockResolvedValue(Buffer.from([1, 2, 3]))
    okPrediction()
    okPersist('/uploads/u1/generated/c1/999-edcba987.png')

    const res = (await run({
      prompt: 'make it night',
      baseImageUrl: '/uploads/u1/chats/c1/1-a.png'
    })) as any

    expect(getImageModel).toHaveBeenCalledWith('edit')
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
    expect(res.modelId).toBe('google/nano-banana')
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
    vi.mocked(getImageModel).mockReturnValue(EDIT_MODEL)
    okPrediction()
    okPersist()

    await run({
      prompt: 'restyle',
      baseImageUrl: 'https://example.com/pic.jpg'
    })

    expect(readFileMock).not.toHaveBeenCalled()
    expect(getImageModel).toHaveBeenCalledWith('edit')
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
    vi.mocked(getImageModel).mockReturnValue(GENERATE_MODEL)
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
})
