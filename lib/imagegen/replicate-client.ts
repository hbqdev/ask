// Server-only Replicate prediction runner. No SDK — the HTTP surface is two
// endpoints and keeping it explicit lets us classify errors precisely.

export type ReplicateResult =
  | { ok: true; outputUrl: string }
  | {
      ok: false
      errorClass:
        | 'auth'
        | 'billing'
        | 'content'
        | 'timeout'
        | 'model'
        | 'network'
      message: string
    }

const API = 'https://api.replicate.com/v1'
const POLL_INTERVAL_MS = 1500

function timeoutMs(): number {
  const n = Number(process.env.REPLICATE_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 120000
}

function firstUrl(output: unknown): string | null {
  if (typeof output === 'string') return output
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0]
  return null
}

function classifyHttp(status: number): 'auth' | 'billing' | 'model' {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'billing'
  return 'model'
}

function classifyFailure(error: string): 'content' | 'model' {
  return /sensitive|nsfw|safety|flagged/i.test(error) ? 'content' : 'model'
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runReplicatePrediction(args: {
  modelPath: string
  input: Record<string, unknown>
  signal?: AbortSignal
}): Promise<ReplicateResult> {
  const token = process.env.REPLICATE_API_TOKEN
  if (!token)
    return {
      ok: false,
      errorClass: 'auth',
      message: 'REPLICATE_API_TOKEN is not set'
    }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'wait'
  }
  const deadline = Date.now() + timeoutMs()

  // Bound the whole operation — including the initial Prefer:wait request — at
  // REPLICATE_TIMEOUT_MS, and honor any caller-supplied cancellation signal.
  const signals = [AbortSignal.timeout(timeoutMs())]
  if (args.signal) signals.push(args.signal)
  const signal = AbortSignal.any(signals)

  let prediction: {
    id?: string
    status?: string
    output?: unknown
    error?: string | null
  }
  try {
    const res = await fetch(`${API}/models/${args.modelPath}/predictions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: args.input }),
      signal
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      return {
        ok: false,
        errorClass: classifyHttp(res.status),
        message: body?.detail || `Replicate returned HTTP ${res.status}`
      }
    }
    prediction = await res.json()
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === 'TimeoutError' || e.name === 'AbortError') &&
      Date.now() >= deadline
    ) {
      return {
        ok: false,
        errorClass: 'timeout',
        message: 'Image generation timed out'
      }
    }
    return {
      ok: false,
      errorClass: 'network',
      message: e instanceof Error ? e.message : 'fetch failed'
    }
  }

  // Poll past the sync window for slow models.
  while (
    prediction.status === 'starting' ||
    prediction.status === 'processing'
  ) {
    if (Date.now() > deadline) {
      return {
        ok: false,
        errorClass: 'timeout',
        message: 'Image generation timed out'
      }
    }
    await sleep(POLL_INTERVAL_MS)
    try {
      const res = await fetch(`${API}/predictions/${prediction.id}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal
      })
      if (!res.ok) {
        return {
          ok: false,
          errorClass: classifyHttp(res.status),
          message: `poll HTTP ${res.status}`
        }
      }
      prediction = await res.json()
    } catch (e) {
      if (
        e instanceof Error &&
        (e.name === 'TimeoutError' || e.name === 'AbortError') &&
        Date.now() >= deadline
      ) {
        return {
          ok: false,
          errorClass: 'timeout',
          message: 'Image generation timed out'
        }
      }
      return {
        ok: false,
        errorClass: 'network',
        message: e instanceof Error ? e.message : 'poll failed'
      }
    }
  }

  if (prediction.status === 'succeeded') {
    const url = firstUrl(prediction.output)
    if (url) return { ok: true, outputUrl: url }
    return {
      ok: false,
      errorClass: 'model',
      message: 'Prediction succeeded but returned no image URL'
    }
  }
  const errMsg = prediction.error || `Prediction ${prediction.status}`
  return {
    ok: false,
    errorClass: classifyFailure(String(errMsg)),
    message: String(errMsg)
  }
}
