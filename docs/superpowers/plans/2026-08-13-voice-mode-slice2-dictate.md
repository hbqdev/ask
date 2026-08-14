# Voice Mode — Slice 2 (Dictate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user hold a mic button, speak a question, and have a self-hosted Whisper model transcribe it into the composer — the input half of two-way voice.

**Architecture:** A bolt-on that mirrors Slice 1 (read-aloud) exactly. A new self-hosted Whisper STT service (`ask-whisper`, OpenAI-compatible `POST /v1/audio/transcriptions`) runs on a **fleet GPU box** (NightFuryX, on its RTX 2080 Ti), reached over the LAN exactly like the reranker; a thin gated+authed `/api/voice/transcribe` route forwards audio to it via a `transcribeAudio()` client; a client `useVoiceDictation` hook captures mic audio with `MediaRecorder` and a `MicButton` in the composer sends it and **auto-submits** the transcript. Every path fails open — a dictation failure never blocks typing.

**Tech Stack:** Next.js 16 (App Router route handler), faster-whisper served by **speaches** (`ghcr.io/speaches-ai/speaches`, CUDA/GPU, `float16` on the Turing 2080 Ti), browser `MediaRecorder`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-voice-mode-design.md` (§4.1 STT service + `/api/voice/transcribe`; §9 Slice 2).

## Global Constraints

- **Lab-first.** All work lands on branch `flow-design` (`ask-flow` worktree) and runs on the lab (`:3742`). No staging/prod changes.
- **Two-flag gate, identical to Slice 1.** `VOICE_ENABLED` (server, per-call `process.env` read) gates the endpoint; `NEXT_PUBLIC_VOICE_ENABLED` (client, build-inlined via the worktree `.env`) gates the UI. The mic reuses the SAME client gate as the Slice 1 speak toggle — no new `NEXT_PUBLIC_*` var. Both flags off ⇒ byte-identical to today.
- **Fail-open everywhere.** STT down / mic denied / oversized audio ⇒ return to idle silently (or a toast), never wedge the composer; typing is always available.
- **Self-hosted only.** No cloud STT. Audio is transcribed on the fleet and is ephemeral (never persisted); only the transcript enters the composer as normal text.
- **Mirror Slice 1 patterns.** New files copy the shape of their Slice 1 twin (named below per task). Read the twin before writing.
- **Verify the service contract empirically — do NOT assume.** Slice 1 shipped a bug because the brief guessed Kokoro's port/path. Before wiring the client, pull the speaches image and confirm its real listen port, health path, and the exact `/v1/audio/transcriptions` request/response shape with `curl`. Pin the image by digest.
- **Commits:** author is the repo default (Tin Tran). Do NOT add any AI/Claude co-author or attribution trailer.
- **Checks before each commit:** `bun typecheck`, `bun lint` (import sorting), `bun run test` for touched tests.

---

## File Structure

| File | New/Mod | Responsibility | Slice 1 twin |
|---|---|---|---|
| `lib/voice/config.ts` | Mod | Add `whisperServiceUrl()`, `sttModelId()` env accessors | (same file) |
| `lib/voice/stt-client.ts` | New | `transcribeAudio(blob) → text` via OpenAI transcription API | `lib/voice/tts-client.ts` |
| `app/api/voice/transcribe/route.ts` | New | Gated+authed multipart endpoint → `{ text }` | `app/api/voice/speak/route.ts` |
| `whisper/docker-compose.yml` (+ source dir) | New | GPU Whisper service deployed on NightFuryX (`ask-whisper`, :8788) | `reranker-qwen/` |
| `docker-compose.lab.yaml` | Mod | `WHISPER_SERVICE_URL`/`VOICE_STT_MODEL` env pointing the app at the box | (env only) |
| `ask/fleet-boot/ask-fleet-boot.sh` | Mod | `reconcile … ask-whisper` in the NightFuryX branch (boot survival) | (existing reconcile lines) |
| `hooks/use-voice-dictation.ts` | New | `MediaRecorder` capture → POST → `onTranscript(text)` | `hooks/use-speech-playback.ts` |
| `components/voice/mic-button.tsx` | New | Push-to-talk mic button (idle/recording/transcribing) | `components/voice/speak-button.tsx` |
| `components/chat-panel.tsx` | Mod | Render `MicButton` in the left cluster; transcript → input | (same file, near the voice toggle at ~L836) |

---

### Task 1: STT config accessors

**Files:**
- Modify: `lib/voice/config.ts`
- Test: `lib/voice/__tests__/config.test.ts` (create if absent, else extend)

**Interfaces:**
- Produces: `whisperServiceUrl(): string | undefined`, `sttModelId(): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/config.test.ts (add these; keep any existing tests)
import { afterEach, describe, expect, it } from 'vitest'
import { sttModelId, whisperServiceUrl } from '../config'

describe('STT config', () => {
  afterEach(() => {
    delete process.env.WHISPER_SERVICE_URL
    delete process.env.VOICE_STT_MODEL
  })
  it('whisperServiceUrl is undefined when unset (fail-open)', () => {
    expect(whisperServiceUrl()).toBeUndefined()
  })
  it('whisperServiceUrl returns the env value when set', () => {
    process.env.WHISPER_SERVICE_URL = 'http://ask-whisper-lab:8000'
    expect(whisperServiceUrl()).toBe('http://ask-whisper-lab:8000')
  })
  it('sttModelId defaults to distil-large-v3', () => {
    expect(sttModelId()).toBe('Systran/faster-distil-whisper-large-v3')
  })
  it('sttModelId honors the env override', () => {
    process.env.VOICE_STT_MODEL = 'Systran/faster-whisper-small'
    expect(sttModelId()).toBe('Systran/faster-whisper-small')
  })
})
```

- [ ] **Step 2: Run it, confirm it fails** — `bun run test lib/voice/__tests__/config.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement** — append to `lib/voice/config.ts`:

```ts
// Container-to-container URL for the self-hosted Whisper STT service. Unset ⇒
// dictation degrades to text-only (fail open), mirroring ttsServiceUrl.
export function whisperServiceUrl(): string | undefined {
  return process.env.WHISPER_SERVICE_URL || undefined
}

// faster-whisper model the STT service loads. distil-large-v3 is the design
// default; a lighter model (e.g. Systran/faster-whisper-small) can be set per
// deployment if CPU transcription latency is too high.
export function sttModelId(): string {
  return process.env.VOICE_STT_MODEL || 'Systran/faster-distil-whisper-large-v3'
}
```

- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Commit** — `git add lib/voice/config.ts lib/voice/__tests__/config.test.ts && git commit -m "feat(voice): STT service config accessors"`

---

### Task 2: STT client (`transcribeAudio`)

**Files:**
- Create: `lib/voice/stt-client.ts`
- Test: `lib/voice/__tests__/stt-client.test.ts`

**Interfaces:**
- Consumes: `whisperServiceUrl()`, `sttModelId()` (Task 1)
- Produces: `transcribeAudio(audio: Blob, opts?: { model?: string; signal?: AbortSignal }): Promise<string>`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from '../stt-client'

const blob = new Blob(['x'], { type: 'audio/webm' })

describe('transcribeAudio', () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.WHISPER_SERVICE_URL })

  it('throws when the service URL is not configured', async () => {
    await expect(transcribeAudio(blob)).rejects.toThrow(/not configured/)
  })

  it('POSTs multipart to /v1/audio/transcriptions and returns text', async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: '  hello world  ' }), { status: 200 })
    )
    const text = await transcribeAudio(blob)
    expect(text).toBe('hello world') // trimmed
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://stt:8000/v1/audio/transcriptions')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBeInstanceOf(FormData)
  })

  it('throws on a non-OK response', async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(transcribeAudio(blob)).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement** `lib/voice/stt-client.ts`:

```ts
import { sttModelId, whisperServiceUrl } from './config'

// POST recorded audio to the self-hosted Whisper service (OpenAI-compatible
// transcription API) and return the transcript. Mirrors tts-client's
// synthesizeSpeech: the service speaks the OpenAI /v1/audio/transcriptions
// contract (multipart form: file, model, response_format=json → { text }).
export async function transcribeAudio(
  audio: Blob,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const base = whisperServiceUrl()
  if (!base) {
    throw new Error('STT service is not configured (WHISPER_SERVICE_URL)')
  }

  const form = new FormData()
  form.append('file', audio, 'audio.webm')
  form.append('model', opts.model ?? sttModelId())
  form.append('response_format', 'json')

  const res = await fetch(`${base}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: opts.signal
  })
  if (!res.ok) throw new Error(`STT service responded ${res.status}`)

  const data = (await res.json()) as { text?: unknown }
  if (typeof data.text !== 'string') {
    throw new Error('STT service returned no text')
  }
  return data.text.trim()
}
```

- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Commit** — `git add lib/voice/stt-client.ts lib/voice/__tests__/stt-client.test.ts && git commit -m "feat(voice): STT client for the transcription service"`

---

### Task 3: `/api/voice/transcribe` route

**Files:**
- Create: `app/api/voice/transcribe/route.ts`
- Test: `app/api/voice/__tests__/transcribe.test.ts`

**Interfaces:**
- Consumes: `isVoiceEnabled()` (config), `getCurrentUserId()` (`@/lib/auth/get-current-user`), `transcribeAudio()` (Task 2)
- Produces: `POST(req: Request): Promise<Response>` returning `{ text: string }`

**Contract (mirror `/api/voice/speak`):** 404 when voice off · 401 no user · 400 no/invalid file · 413 too large · 503 when STT throws · 200 `{ text }`.

- [ ] **Step 1: Write the failing test** (mock the three deps):

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/voice/config', () => ({ isVoiceEnabled: vi.fn() }))
vi.mock('@/lib/auth/get-current-user', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('@/lib/voice/stt-client', () => ({ transcribeAudio: vi.fn() }))

import { isVoiceEnabled } from '@/lib/voice/config'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { transcribeAudio } from '@/lib/voice/stt-client'
import { POST } from '../transcribe/route'

const withFile = () => {
  const form = new FormData()
  form.append('file', new Blob(['x'], { type: 'audio/webm' }), 'a.webm')
  return new Request('http://t/api/voice/transcribe', { method: 'POST', body: form })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/voice/transcribe', () => {
  it('404 when voice disabled', async () => {
    ;(isVoiceEnabled as any).mockReturnValue(false)
    expect((await POST(withFile())).status).toBe(404)
  })
  it('401 when no user', async () => {
    ;(isVoiceEnabled as any).mockReturnValue(true)
    ;(getCurrentUserId as any).mockResolvedValue(null)
    expect((await POST(withFile())).status).toBe(401)
  })
  it('400 when no file', async () => {
    ;(isVoiceEnabled as any).mockReturnValue(true)
    ;(getCurrentUserId as any).mockResolvedValue('u1')
    const req = new Request('http://t', { method: 'POST', body: new FormData() })
    expect((await POST(req)).status).toBe(400)
  })
  it('200 { text } on success', async () => {
    ;(isVoiceEnabled as any).mockReturnValue(true)
    ;(getCurrentUserId as any).mockResolvedValue('u1')
    ;(transcribeAudio as any).mockResolvedValue('hello there')
    const res = await POST(withFile())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello there' })
  })
  it('503 when STT throws', async () => {
    ;(isVoiceEnabled as any).mockReturnValue(true)
    ;(getCurrentUserId as any).mockResolvedValue('u1')
    ;(transcribeAudio as any).mockRejectedValue(new Error('down'))
    expect((await POST(withFile())).status).toBe(503)
  })
})
```

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement** `app/api/voice/transcribe/route.ts`:

```ts
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { transcribeAudio } from '@/lib/voice/stt-client'

// Bound abuse + STT latency. ~25MB matches OpenAI's audio limit and holds well
// over a minute of Opus — far more than a push-to-talk clip needs.
const MAX_BYTES = 25 * 1024 * 1024

export async function POST(req: Request): Promise<Response> {
  // Feature-gated: when off, the endpoint does not exist.
  if (!isVoiceEnabled()) return new Response('Not found', { status: 404 })

  const userId = await getCurrentUserId()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let audio: File | null = null
  try {
    const form = await req.formData()
    const f = form.get('file')
    if (f instanceof File) audio = f
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (!audio || audio.size === 0) return new Response('No audio', { status: 400 })
  if (audio.size > MAX_BYTES) {
    return new Response('Audio too large', { status: 413 })
  }

  try {
    const text = await transcribeAudio(audio)
    return new Response(JSON.stringify({ text }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    })
  } catch (e) {
    console.warn('[voice] /transcribe failed:', e)
    return new Response('STT unavailable', { status: 503 })
  }
}
```

- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Commit** — `git add app/api/voice/transcribe/route.ts app/api/voice/__tests__/transcribe.test.ts && git commit -m "feat(voice): /api/voice/transcribe endpoint"`

---

### Task 4: Whisper GPU service on NightFuryX (`ask-whisper`)

**Files:**
- Create (source of truth on .231, a standalone infra dir like `reranker-qwen/`, NOT inside the app repo): `/home/nightfury/selfhosted/whisper/docker-compose.yml`
- Deploy to NightFuryX (`192.168.50.17`): `/home/nightfury/selfhosted/whisper/`
- Modify (flow-design): `docker-compose.lab.yaml` — two env vars on the `ask` service
- Modify (flow-design): `fleet-boot/ask-fleet-boot.sh` — one `reconcile` line, then run `fleet-boot/deploy.sh`

**Target GPU (confirmed live):** NightFuryX `192.168.50.17`, GPU 0 = **RTX 2080 Ti**, UUID `GPU-1eed568b-e1d4-1e19-8a8a-1d4883b133c7`. Turing → fast fp16 (Tensor cores), so use **`float16`** compute. This card also runs the **shared Qwen3 reranker** (~17.9 GB used, ~4.3 GB free); distil-large-v3 float16 (~1.5–2 GB) fits, and lab-volume voice won't meaningfully contend with live reranking — drop to `int8_float16` if VRAM gets tight. (Fallback: the idle Quadro P2200 on GPU 1, UUID `GPU-7b3c2a28-e2ae-9cd4-2e25-7e7d164548c9`, is zero-contention but Pascal fp16 is slow.) `nvidia-smi` lives at `/usr/lib/wsl/lib/nvidia-smi` on these WSL2 boxes.

**No unit test — deliverable is a running service verified by `curl`. Verify the speaches contract empirically (Global Constraint); do not trust the assumed port/path/env-names.**

- [ ] **Step 1: Confirm the speaches CUDA image + contract on NightFuryX.** SSH in, pull `ghcr.io/speaches-ai/speaches:latest-cuda` (confirm the current CUDA tag from the speaches README), run it briefly bound to the P2200, and probe:

```bash
ssh nightfury@192.168.50.17
docker run --rm --gpus '"device=GPU-1eed568b-e1d4-1e19-8a8a-1d4883b133c7"' \
  -p 8790:8000 ghcr.io/speaches-ai/speaches:latest-cuda &
sleep 30
curl -fsS http://localhost:8790/health
curl -fsS -F 'file=@sample.wav' -F 'model=Systran/faster-distil-whisper-large-v3' \
  -F 'response_format=json' http://localhost:8790/v1/audio/transcriptions
```

Record the real **listen port, health path, the `{ text }` shape, the model-preload + compute-type env-var names** (speaches config keys — confirm; the compose below assumes `WHISPER__MODEL` / `WHISPER__COMPUTE_TYPE`), and the **HF cache path** inside the image. If any differ, update the compose + `stt-client.ts` and note it in the report. Resolve the pinned digest: `docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/speaches-ai/speaches:latest-cuda`.

- [ ] **Step 2: Create `/home/nightfury/selfhosted/whisper/docker-compose.yml`** on .231, modeled on `reranker-qwen/docker-compose.yml`:

```yaml
# Self-hosted Whisper STT for voice dictation (Slice 2), on NightFuryX
# (192.168.50.17), pinned to GPU 0 = RTX 2080 Ti (Turing, fast fp16) by UUID.
# This card also runs the shared Qwen3 reranker; distil-large-v3 float16 fits
# in the ~4.3GB headroom and lab voice won't meaningfully contend with it.
# Ask reaches it over the LAN at http://192.168.50.17:8788. speaches speaks the
# OpenAI-compatible transcription API (POST /v1/audio/transcriptions).
name: ask-whisper
services:
  whisper:
    image: ghcr.io/speaches-ai/speaches:latest-cuda@sha256:<PIN>
    container_name: ask-whisper
    environment:
      # Confirm exact env names in Step 1. Intent: preload distil-large-v3,
      # float16 (2080 Ti is Turing — fast fp16). Drop to int8_float16 if the
      # shared-GPU VRAM headroom gets tight.
      WHISPER__MODEL: 'Systran/faster-distil-whisper-large-v3'
      WHISPER__COMPUTE_TYPE: 'float16'
    ports:
      - '8788:8000'
    volumes:
      - hf-cache:/home/ubuntu/.cache/huggingface # confirm cache path in Step 1
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ['GPU-1eed568b-e1d4-1e19-8a8a-1d4883b133c7'] # 2080 Ti
              capabilities: [gpu]
    healthcheck:
      test:
        [
          'CMD',
          'python',
          '-c',
          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
        ]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 600s # first boot downloads the model
    restart: unless-stopped

volumes:
  hf-cache:
    name: ask-whisper-hf-cache
```

- [ ] **Step 3: Deploy to NightFuryX + verify from .231.**

```bash
rsync -a /home/nightfury/selfhosted/whisper/ nightfury@192.168.50.17:/home/nightfury/selfhosted/whisper/
ssh nightfury@192.168.50.17 'cd /home/nightfury/selfhosted/whisper && docker compose up -d'
# wait for healthy, then from .231:
curl -fsS http://192.168.50.17:8788/health
curl -fsS -F 'file=@sample.wav' -F 'model=Systran/faster-distil-whisper-large-v3' \
  -F 'response_format=json' http://192.168.50.17:8788/v1/audio/transcriptions
```

- [ ] **Step 4: Point the app at it** — add to the `ask` service `environment:` in `docker-compose.lab.yaml` (next to the Slice 1 `VOICE_ENABLED`/`TTS_SERVICE_URL` lines):

```yaml
      # --- voice dictate (Slice 2): Whisper on NightFuryX's P2200 ----------
      WHISPER_SERVICE_URL: 'http://192.168.50.17:8788'
      VOICE_STT_MODEL: 'Systran/faster-distil-whisper-large-v3'
```

- [ ] **Step 5: Boot survival** — add to the `NightFuryX)` branch of `fleet-boot/ask-fleet-boot.sh`, beside the reranker/ingestor lines:

```bash
    reconcile /home/nightfury/selfhosted/whisper ask-whisper
```

Then push the updated unit to the boxes: `cd fleet-boot && ./deploy.sh`.

- [ ] **Step 6: Commit** (flow-design app-repo changes only — the `whisper/` dir is standalone infra outside the app repo, like `reranker-qwen/`):
`git add docker-compose.lab.yaml fleet-boot/ask-fleet-boot.sh && git commit -m "feat(voice): run ask-whisper on NightFuryX P2200; point lab app at it"`

---

### Task 5: Dictation hook (`useVoiceDictation`)

**Files:**
- Create: `hooks/use-voice-dictation.ts`
- Test: `hooks/__tests__/use-voice-dictation.test.ts`

**Interfaces:**
- Produces: `useVoiceDictation(onTranscript: (text: string) => void): { state: 'idle'|'recording'|'transcribing'; start(): Promise<void>; stop(): void }`

**Note on testing:** `MediaRecorder` and `navigator.mediaDevices` don't exist in jsdom — the test stubs them. Assert (a) `start()` moves to `recording`; (b) when the recorder's `onstop` fires, it POSTs to `/api/voice/transcribe` and calls `onTranscript` with the trimmed text; (c) a mic-permission rejection returns to `idle` without throwing.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useVoiceDictation } from '../use-voice-dictation'

class FakeRecorder {
  state = 'inactive'
  ondataavailable: any
  onstop: any
  mimeType = 'audio/webm'
  constructor(public stream: any) {}
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

afterEach(() => vi.restoreAllMocks())

it('records, transcribes, and reports the transcript', async () => {
  ;(globalThis as any).MediaRecorder = FakeRecorder
  ;(navigator as any).mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] })
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ text: 'hi there' }), { status: 200 })
  )
  const onTranscript = vi.fn()
  const { result } = renderHook(() => useVoiceDictation(onTranscript))

  await act(async () => { await result.current.start() })
  expect(result.current.state).toBe('recording')
  await act(async () => { result.current.stop() })
  expect(onTranscript).toHaveBeenCalledWith('hi there')
  expect(result.current.state).toBe('idle')
})

it('returns to idle when mic permission is denied', async () => {
  ;(navigator as any).mediaDevices = {
    getUserMedia: vi.fn().mockRejectedValue(new Error('denied'))
  }
  const { result } = renderHook(() => useVoiceDictation(vi.fn()))
  await act(async () => { await result.current.start() })
  expect(result.current.state).toBe('idle')
})
```

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement** `hooks/use-voice-dictation.ts`:

```ts
'use client'
import { useCallback, useRef, useState } from 'react'

type DictationState = 'idle' | 'recording' | 'transcribing'

// Push-to-talk capture: start() opens the mic and records; stop() finalizes,
// POSTs the audio to /api/voice/transcribe, and resolves the transcript via
// onTranscript. Fail-quiet: any error returns to idle so the mic UI never
// wedges and typing is always available (mirrors use-speech-playback).
export function useVoiceDictation(onTranscript: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm'
        })
        if (blob.size === 0) {
          setState('idle')
          return
        }
        setState('transcribing')
        try {
          const form = new FormData()
          form.append('file', blob, 'audio.webm')
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST',
            body: form
          })
          if (res.ok) {
            const { text } = await res.json()
            if (typeof text === 'string' && text.trim()) {
              onTranscript(text.trim())
            }
          }
        } catch {
          /* fail-quiet: dictation is additive; typing still works */
        }
        setState('idle')
      }
      recorder.start()
      recorderRef.current = recorder
      setState('recording')
    } catch {
      setState('idle')
    }
  }, [onTranscript])

  const stop = useCallback(() => {
    const r = recorderRef.current
    if (r && r.state !== 'inactive') r.stop()
  }, [])

  return { state, start, stop }
}
```

- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Commit** — `git add hooks/use-voice-dictation.ts hooks/__tests__/use-voice-dictation.test.ts && git commit -m "feat(voice): useVoiceDictation mic-capture hook"`

---

### Task 6: Mic button

**Files:**
- Create: `components/voice/mic-button.tsx`
- Test: `components/voice/__tests__/mic-button.test.tsx`

**Interfaces:**
- Consumes: `useVoiceDictation` (Task 5)
- Produces: `<MicButton onTranscript={(text: string) => void} disabled?={boolean} />`

**Behavior:** push-to-talk — `onPointerDown` → `start()`, `onPointerUp`/`onPointerLeave` → `stop()`. Disabled while `transcribing`. Wrapped in the same `Tooltip` treatment as the Slice 1 voice toggle. Uses the design-system `Button` (`variant="ghost" size="icon"`).

- [ ] **Step 1: Write the failing test** (mock the hook):

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const start = vi.fn()
const stop = vi.fn()
let state: 'idle' | 'recording' | 'transcribing' = 'idle'
vi.mock('@/hooks/use-voice-dictation', () => ({
  useVoiceDictation: () => ({ state, start, stop })
}))
import { MicButton } from '../mic-button'

it('starts on pointer down and stops on pointer up', () => {
  render(<MicButton onTranscript={vi.fn()} />)
  const btn = screen.getByRole('button', { name: /dictate/i })
  fireEvent.pointerDown(btn)
  expect(start).toHaveBeenCalled()
  state = 'recording'
  fireEvent.pointerUp(btn)
  expect(stop).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run it, confirm it fails.**

- [ ] **Step 3: Implement** `components/voice/mic-button.tsx` (confirm the icon export names against the installed `@tabler/icons-react` — `IconMicrophone`, `IconLoader2` are expected):

```tsx
'use client'
import {
  IconLoader2 as Loader,
  IconMicrophone as Microphone
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { useVoiceDictation } from '@/hooks/use-voice-dictation'

import { Button } from '../ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '../ui/tooltip'

// Push-to-talk mic for dictation. Hold to record, release to transcribe; the
// transcript is handed to onTranscript (the composer drops it into the input).
export function MicButton({
  onTranscript,
  disabled
}: {
  onTranscript: (text: string) => void
  disabled?: boolean
}) {
  const { state, start, stop } = useVoiceDictation(onTranscript)
  const recording = state === 'recording'
  const busy = state === 'transcribing'

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={recording ? 'Stop recording' : 'Dictate'}
            aria-pressed={recording}
            disabled={disabled || busy}
            onPointerDown={() => {
              if (!busy) void start()
            }}
            onPointerUp={() => {
              if (recording) stop()
            }}
            onPointerLeave={() => {
              if (recording) stop()
            }}
            className={cn(
              'size-8 shrink-0 rounded-full',
              recording ? 'text-red-500' : 'text-muted-foreground'
            )}
          >
            {busy ? (
              <Loader className="size-4 animate-spin" />
            ) : (
              <Microphone className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="text-xs">
          {busy ? 'Transcribing…' : 'Hold to dictate'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
```

- [ ] **Step 4: Run it, confirm it passes.**
- [ ] **Step 5: Commit** — `git add components/voice/mic-button.tsx components/voice/__tests__/mic-button.test.tsx && git commit -m "feat(voice): push-to-talk MicButton"`

---

### Task 7: Wire the mic into the composer

**Files:**
- Modify: `components/chat-panel.tsx`

**Interfaces:**
- Consumes: `MicButton` (Task 6). Uses existing `voiceEnabled` gate (`chat-panel.tsx:152`), `input`, `handleInputChange`, `inputRef`, `isLoading`.

**Behavior:** render `<MicButton>` in the left button cluster, immediately after the Slice 1 voice-toggle block (`chat-panel.tsx` ~L868), under the same `{voiceEnabled && …}` gate. On transcript, populate the composer and **auto-submit** (mirroring `ActionButtons`' set-then-`requestSubmit`) for a hands-free conversational feel; an ASR error submits as-is (accepted per the chosen UX).

- [ ] **Step 1: Add the import** (with the other `./voice`/component imports):

```ts
import { MicButton } from './voice/mic-button'
```

- [ ] **Step 2: Add the transcript handler** inside `ChatPanel`, near `handleNewChat`:

```ts
const handleTranscript = useCallback(
  (text: string) => {
    const next = input.trim() ? `${input.trim()} ${text}` : text
    handleInputChange({
      target: { value: next }
    } as React.ChangeEvent<HTMLTextAreaElement>)
    // Auto-submit for a hands-free feel. Mirror ActionButtons: a short delay
    // (INPUT_UPDATE_DELAY_MS, already defined in this file) lets the controlled
    // input value settle before requestSubmit reads it.
    setTimeout(() => {
      inputRef.current?.form?.requestSubmit()
      setIsInputFocused(false)
      inputRef.current?.blur()
    }, INPUT_UPDATE_DELAY_MS)
  },
  [input, handleInputChange]
)
```

- [ ] **Step 3: Render the button** — directly after the closing `)}` of the Slice 1 voice-toggle `{voiceEnabled && ( … )}` block in the left cluster:

```tsx
{voiceEnabled && (
  <MicButton onTranscript={handleTranscript} disabled={isLoading} />
)}
```

- [ ] **Step 4: Verify** — `bun typecheck` + `bun lint` clean. There is no unit test for this wiring (it's presentational glue over tested units); it is covered by the Task-8 manual lab pass.

- [ ] **Step 5: Commit** — `git add components/chat-panel.tsx && git commit -m "feat(voice): mic button in the composer (dictate → input)"`

---

### Task 8: Lab rebuild + manual verification

**Files:** none (build + browser).

- [ ] **Step 1:** Ensure `NEXT_PUBLIC_VOICE_ENABLED=true` is in `ask-flow/.env` (already set for Slice 1) — the mic reuses this gate, so no `.env` change is needed; just confirm it's present.
- [ ] **Step 2:** Rebuild the lab app so the new endpoint + client ship (the Whisper service is already up on NightFuryX from Task 4):
  `docker compose -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d --build ask`
- [ ] **Step 3:** Browser (`:3742`, requires an HTTPS or `localhost`/LAN context that allows `getUserMedia`; if the LAN-IP origin blocks the mic, test via `http://localhost:3742` on the host or a trusted-origin flag): the mic button appears next to the speak toggle. Hold it, say a sentence, release → the transcript lands in the composer. Send it → a normal answer turn runs.
- [ ] **Step 4:** Exercise fail-open: stop the remote STT (`ssh nightfury@192.168.50.17 'docker stop ask-whisper'`), try dictation → the button returns to idle, no crash, typing still works; then restart it (`ssh … 'docker start ask-whisper'`). Deny mic permission → same idle-return.
- [ ] **Step 5:** No commit (verification only). Record measured first-transcript latency in the task report; if CPU distil-large-v3 is too slow, note it — dropping `VOICE_STT_MODEL` to `Systran/faster-whisper-small` is a one-line compose change.

---

## Decisions made

1. **Whisper runs GPU on NightFuryX's RTX 2080 Ti** (`float16`, UUID `GPU-1eed568b-…`), reached at `http://192.168.50.17:8788` — spec-compliant (GPU distil-large-v3) and fast (Turing fp16). It shares the card with the prod/shared Qwen3 reranker; the ~4.3 GB headroom holds distil-large-v3 float16, and lab voice volume won't meaningfully contend with live reranking. The idle Quadro P2200 (GPU 1) is the zero-contention fallback if reranker VRAM ever tightens.
2. **Transcript auto-submits** after transcription for a hands-free conversational feel. An ASR error is submitted as-is (accepted trade-off); a "review before send" toggle can be added later if it proves annoying.

## Self-review

- **Spec coverage:** §4.1 STT service → Task 4; `/api/voice/transcribe` → Task 3; STT client → Task 2; push-to-talk mic → Tasks 5–7; flags/fail-open → Global Constraints + Tasks 3/5/8; §8 unit+integration+lab tests → Tasks 1–3,5,6 (unit) + Task 8 (lab). Vision/full-duplex remain out of scope (spec §2). ✓
- **Type consistency:** `transcribeAudio(Blob) → Promise<string>` (Task 2) consumed by Task 3; `useVoiceDictation(onTranscript) → {state,start,stop}` (Task 5) consumed by Task 6; `MicButton({onTranscript,disabled})` (Task 6) consumed by Task 7. `whisperServiceUrl`/`sttModelId` (Task 1) consumed by Task 2. ✓
- **Placeholders:** none — every code step is complete; the one deliberate `<PIN>` is the digest the implementer resolves empirically in Task 4, per the verify-the-contract constraint. ✓
