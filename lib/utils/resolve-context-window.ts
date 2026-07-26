// Resolves a model's REAL context window, so truncation is sized by what the
// model can actually take rather than by a guess.
//
// Background: the inherited context-window.ts carries a static map of 16 cloud
// model IDs and defaults everything else to 16384 tokens. Every model we run is
// an Ollama model and none are in that map, so all of them were being held to
// 10650 tokens of history — against a measured real window of 262144 for
// kimi-k2.6:cloud. Upstream already fetches an Ollama context window in
// lib/ollama/client.ts but never wires it into truncation.
//
// Contract: a number means "this is the real window"; null means "unknown, do
// not truncate". Never invent a window — a wrong small number silently discards
// the user's conversation, which is worse than not truncating at all.

import type { Model } from '../types/models'

import { getStaticContextWindow } from './context-window'

const PROBE_TIMEOUT_MS = 2_000

// null is a cached "unknown" — a down Ollama must not add a probe per turn.
const cache = new Map<string, number | null>()

/** Test seam: module-level cache would otherwise leak between cases. */
export function __resetContextWindowCacheForTests(): void {
  cache.clear()
}

function ollamaBaseUrl(): string {
  const raw =
    process.env.OLLAMA_BASE_URL ||
    process.env.OLLAMA_HOST ||
    'http://localhost:11434'
  // Config commonly carries the OpenAI-compat suffix; /api/show sits at the root.
  return raw.replace(/\/v1\/?$/, '').replace(/\/$/, '')
}

/**
 * Ollama namespaces the field by architecture — `kimi-k2.context_length`,
 * `qwen3.context_length`, `llama.context_length` — so match on the suffix
 * instead of enumerating architectures we would then have to maintain.
 */
function readContextLength(modelInfo: unknown): number | null {
  if (!modelInfo || typeof modelInfo !== 'object') return null
  for (const [key, value] of Object.entries(
    modelInfo as Record<string, unknown>
  )) {
    if (!key.endsWith('.context_length') && key !== 'context_length') continue
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
  }
  return null
}

async function probeOllama(modelId: string): Promise<number | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${ollamaBaseUrl()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal
    })
    if (!response.ok) return null
    const json = (await response.json()) as { model_info?: unknown }
    return readContextLength(json?.model_info)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The model's real context window in tokens, or null when it cannot be
 * determined. Probes Ollama at most once per model id per process.
 */
export async function resolveContextWindow(
  model: Model
): Promise<number | null> {
  const staticWindow = getStaticContextWindow(model.id)
  if (staticWindow !== null) return staticWindow

  if (model.providerId !== 'ollama') return null

  const cached = cache.get(model.id)
  if (cached !== undefined) return cached

  const probed = await probeOllama(model.id)
  cache.set(model.id, probed)
  return probed
}
