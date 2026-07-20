import { OllamaClient } from '@/lib/ollama/client'

// Whether an answering model can accept image input directly.
//
// Attached images always get VLM-extracted text at ingestion. At answer
// time we choose per model: a vision-capable model receives the raw image
// (its own vision, preferred); every other model falls back to that
// extracted text. Getting this wrong in one direction is far worse than the
// other — sending an image to a text-only model makes the provider reject
// the entire turn, while a vision model that only gets text still answers.
// So detection is deliberately CONSERVATIVE: anything we can't confirm is
// treated as text-only.
//
// Capability comes from the source of truth for THIS deployment — Ollama's
// own `/api/show` `capabilities` array, which lists "vision" for multimodal
// models (the same endpoint ollama-validator uses to check "tools") — NOT a
// hardcoded list of cloud model-id patterns. An explicit `vision` flag on
// the model still wins, so a non-Ollama model (or a manual override) can
// declare it in config.

export type VisionModel = { id: string; providerId?: string; vision?: boolean }

// Capabilities are effectively static per model tag, so cache the resolved
// boolean in process. The TTL guards against a tag being re-pulled with
// different capabilities without a server restart.
const CAP_CACHE_TTL_MS = 10 * 60 * 1000
const visionCache = new Map<string, { value: boolean; expiresAt: number }>()

async function ollamaHasVision(modelId: string): Promise<boolean> {
  const baseUrl = process.env.OLLAMA_BASE_URL
  if (!baseUrl) return false

  const now = Date.now()
  const cached = visionCache.get(modelId)
  if (cached && cached.expiresAt > now) return cached.value

  let value = false
  try {
    const caps = await new OllamaClient(baseUrl).getModelCapabilities(modelId)
    value = caps.capabilities.includes('vision')
  } catch {
    // Ollama unreachable / model not found: fall back to text-only. This is
    // the safe direction — a vision model that only receives the extracted
    // text still answers, whereas guessing "vision" for a text-only model
    // would make the provider reject the whole turn.
    value = false
  }

  visionCache.set(modelId, { value, expiresAt: now + CAP_CACHE_TTL_MS })
  return value
}

export async function modelSupportsVision(
  model: VisionModel
): Promise<boolean> {
  // Explicit config flag always wins (covers non-Ollama providers and manual
  // overrides), and never triggers a network lookup.
  if (typeof model.vision === 'boolean') return model.vision

  // Ollama is the only provider we can interrogate for capabilities here.
  if (model.providerId === 'ollama') return ollamaHasVision(model.id)

  // Unknown provider with no explicit flag → assume text-only (safe).
  return false
}
