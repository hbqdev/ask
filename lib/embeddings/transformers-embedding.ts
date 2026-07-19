// Server-only — never imported in browser code.
// All three embedding models that Vane ships with, powered by
// @huggingface/transformers + onnxruntime-node (local ONNX inference).
// Models are downloaded from HuggingFace Hub on first use and cached locally.

import path from 'node:path'

export type EmbeddingModelId =
  | 'Xenova/all-MiniLM-L6-v2' // 384d — fastest, good general purpose
  | 'mixedbread-ai/mxbai-embed-large-v1' // 1024d — highest quality
  | 'Xenova/nomic-embed-text-v1' // 768d — good balance

export const EMBEDDING_MODELS: Record<
  EmbeddingModelId,
  { dims: number; label: string }
> = {
  'Xenova/all-MiniLM-L6-v2': { dims: 384, label: 'all-MiniLM-L6-v2' },
  'mixedbread-ai/mxbai-embed-large-v1': {
    dims: 1024,
    label: 'mxbai-embed-large-v1'
  },
  'Xenova/nomic-embed-text-v1': { dims: 768, label: 'nomic-embed-text-v1' }
}

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModelId =
  'Xenova/all-MiniLM-L6-v2'

export function getConfiguredModel(): EmbeddingModelId {
  const env = process.env.EMBEDDING_MODEL
  if (env && env in EMBEDDING_MODELS) return env as EmbeddingModelId
  return DEFAULT_EMBEDDING_MODEL
}

// One pipeline instance per model — created lazily, reused across calls.
const pipelines = new Map<string, any>()

async function getPipeline(modelId: EmbeddingModelId) {
  if (pipelines.has(modelId)) return pipelines.get(modelId)

  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = process.env.MODEL_CACHE_DIR || path.join('/app', 'model-cache')

  // q8, not fp32. Embeddings run on this box's CPU (no GPU anywhere on the app
  // host), and they sit on hot paths: search-intent dedup on EVERY search, plus
  // memory writes and upload RAG. Measured here (mxbai, ~512-token chunks,
  // 16-core CPU): fp32 = 873ms/chunk, q8 = 469ms/chunk — ~1.9x faster.
  // Quantization is effectively free in quality: cos(fp32, q8) = 0.991–0.996 on
  // real memory/answer text, and the output is still 1024-d, so the
  // vector(1024) columns and every stored embedding stay compatible.
  const pipe = await pipeline('feature-extraction', modelId, { dtype: 'q8' })
  pipelines.set(modelId, pipe)
  return pipe
}

// Remote GPU embedding service (selfhosted/embedder, on the P4000 at
// EMBEDDING_SERVICE_URL). Replicates this file's exact semantics (mean
// pooling + L2 normalize) on GPU, so its vectors are interchangeable with
// everything already stored. Any failure falls back to the local CPU path
// below — embeddings never hard-fail because the service is down.
const REMOTE_TIMEOUT_MS = 30_000

function isRemoteConfigured(): boolean {
  return Boolean(
    process.env.EMBEDDING_SERVICE_URL && process.env.EMBEDDING_SERVICE_TOKEN
  )
}

async function embedRemote(
  texts: string[],
  modelId: EmbeddingModelId
): Promise<number[][]> {
  const baseUrl = process.env.EMBEDDING_SERVICE_URL as string
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.EMBEDDING_SERVICE_TOKEN}`
      },
      body: JSON.stringify({ texts, model: modelId }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`embedder HTTP ${response.status}`)
    }
    const json = (await response.json()) as { embeddings?: number[][] }
    if (
      !Array.isArray(json.embeddings) ||
      json.embeddings.length !== texts.length
    ) {
      throw new Error('embedder returned a malformed embeddings array')
    }
    return json.embeddings
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function embedTexts(
  texts: string[],
  modelId: EmbeddingModelId = getConfiguredModel()
): Promise<number[][]> {
  if (texts.length === 0) return []
  if (isRemoteConfigured()) {
    try {
      return await embedRemote(texts, modelId)
    } catch (error) {
      console.warn(
        `[embeddings] remote embedder failed (${
          error instanceof Error ? error.message : String(error)
        }); falling back to local CPU inference`
      )
    }
  }
  const pipe = await getPipeline(modelId)
  const output = await pipe(texts, { pooling: 'mean', normalize: true })
  return output.tolist() as number[][]
}

// Dot product — valid cosine similarity because vectors are already L2-normalized.
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}
