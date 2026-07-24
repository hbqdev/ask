// Demand-triggered GPU warm-up.
//
// The support models (classifier, reranker, embedder) stay resident in VRAM,
// but WSL2 forbids clock-locking (`nvidia-smi -lgc` is "not supported"), so an
// idle GPU drops to power state P8 (~139 MHz, ~8% of max) and the next request
// runs at that crawl clock — the whole cold/warm latency gap.
//
// Measured on the P5000 classifier: pinned at P0 it draws ~47W vs ~9.6W idle
// at P8, so a 24/7 keep-warm loop burns ~37W continuously to save the first
// turn after idle. Instead we warm on *intent* — while the user is actually
// composing — which costs nothing at all when the app sits idle.
//
// Timing that matters: a GPU held at P0 by sustained traffic takes ~45s of
// quiet to drop, but a SINGLE ping only holds P0 for ~14-15s. The warm
// interval is set from the latter (see warm-trigger.ts).
//
// Targets are env-driven with no infra defaults: an unconfigured (or
// tokenless) service is skipped rather than pinged blindly.

export type WarmRequest = {
  url: string
  body: string
  headers: Record<string, string>
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const trimSlash = (url: string) => url.replace(/\/+$/, '')

export function buildWarmRequests(
  env: Record<string, string | undefined>
): WarmRequest[] {
  const requests: WarmRequest[] = []

  // Classifier (Ollama): a 1-token generate. keep_alive:-1 also re-pins the
  // model resident, so this doubles as eviction insurance.
  const classifierBase =
    env.CLASSIFIER_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || ''
  if (classifierBase) {
    requests.push({
      url: `${trimSlash(classifierBase)}/api/generate`,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        model: env.CLASSIFIER_MODEL_ID || 'granite4.1:8b',
        prompt: 'ok',
        stream: false,
        keep_alive: -1,
        options: { num_predict: 1 }
      })
    })
  }

  // Reranker: one query against one passage.
  if (env.RERANKER_URL && env.RERANKER_API_TOKEN) {
    requests.push({
      url: `${trimSlash(env.RERANKER_URL)}/rerank`,
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${env.RERANKER_API_TOKEN}`
      },
      body: JSON.stringify({ query: 'warm', passages: ['warm'] })
    })
  }

  // Embedder: one short text.
  if (env.EMBEDDING_SERVICE_URL && env.EMBEDDING_SERVICE_TOKEN) {
    requests.push({
      url: `${trimSlash(env.EMBEDDING_SERVICE_URL)}/embed`,
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${env.EMBEDDING_SERVICE_TOKEN}`
      },
      body: JSON.stringify({
        texts: ['warm'],
        model: env.EMBEDDING_MODEL,
        kind: 'query'
      })
    })
  }

  return requests
}

/**
 * Throttle gate. The measured P8 decay is ~45s, so a window comfortably under
 * that keeps a composing user warm while letting an abandoned session fall
 * back to idle on its own — no timer to cancel.
 */
export function shouldWarm(
  lastWarmedAt: number | null,
  now: number,
  minIntervalMs: number
): boolean {
  if (lastWarmedAt === null) return true
  return now - lastWarmedAt >= minIntervalMs
}
