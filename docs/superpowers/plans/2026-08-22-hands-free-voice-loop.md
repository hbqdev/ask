# Hands-Free Voice Conversation Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hands-free voice conversation mode to Ask — open a full-screen view, speak a question, hear a short cited answer read aloud, ask a follow-up, all without the keyboard.

**Architecture:** A `fixed inset-0 z-50` overlay hosts its own `useChat` on a fresh `chatId`. A client state machine (`idle → listening → transcribing → thinking → speaking → listening`) drives an in-browser Silero VAD (`@ricky0123/vad-web`) that endpoints on silence, sends each captured turn to the existing `/api/voice/transcribe` (Whisper), auto-submits it through the existing chat stream, then speaks a **condensed** reply (a new tiny `/api/voice/gist` endpoint wrapping the existing `condenseForSpeech`) via the existing `/api/voice/speak` (Kokoro). Sequential turns, no barge-in. Reuses the voice + chat + citation stacks; the only new server code is the gist endpoint.

**Tech Stack:** Next.js 16.2.6 (App Router), React 19.2, Vercel AI SDK v6 (`@ai-sdk/react`, `ai`), TypeScript (strict), Tailwind v4, Vitest 4.1 + Testing Library, `@ricky0123/vad-web` + `onnxruntime-web` (new, in-browser Silero VAD), self-hosted Whisper/Kokoro/granite.

**Spec:** `docs/superpowers/specs/2026-08-22-hands-free-voice-loop-design.md` (read it alongside this plan).

## Global Constraints

- **Build lab-first on `flow-design`** (the lab, now == prod per [[lab-reconciled-to-prod]]); port to staging/prod later via `git cherry-pick -x`. Do NOT touch other worktrees.
- **Author = Tin Tran only.** Commit messages must NOT contain any `Co-Authored-By` / AI-attribution trailer.
- **Self-hosted, no CDN.** VAD ONNX + WASM assets are vendored under `public/vad/` and served same-origin. No external hosts.
- **Client gate:** reuse `process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true'` (read inline; there is no helper). The Talk entry is hidden when off. **Server gate:** every new route calls `isVoiceEnabled()` from `lib/voice/config.ts` (reads `VOICE_ENABLED`) and 404s when off — matching `transcribe`/`speak`.
- **`microphone=(self)`** in `next.config.mjs` is already correct — do NOT change it. `getUserMedia` needs a secure context, so the live-mic path works on prod HTTPS, not on the plain-http LAN lab; server paths + the state machine are unit-tested, live mic is a prod post-port check.
- **Spoken reply is CONDENSED**, not the full answer. The on-screen Listen button's `emitSpokenGist` streams the whole answer; the loop must instead use `condenseForSpeech` (granite 2–3 sentences) via the new `/api/voice/gist`. The loop's own `useChat` sends `voice: false` so the server does NOT also emit `data-spokenGist` (no double granite call).
- **Sequential turns:** exactly one of {mic capture, TTS playback} is ever active. The detector is paused during transcribing/thinking/speaking and re-armed only on return to listening.
- **Commands:** tests `bun run test` (NOT `bun test`); `bun lint`; `bun typecheck`. Test files live beside source or under `__tests__/`.
- **Spec deviation (intentional):** the spec §3 said "no new backend endpoints"; this plan adds ONE tiny endpoint (`/api/voice/gist`) that only wraps the existing `condenseForSpeech`, because it is more isolated than modifying the shared chat-stream gist emission. No new services, no DB changes.

---

## File Structure

**New:**
- `lib/voice/wav.ts` — pure `encodeWav(pcm, sampleRate)` → 16-bit PCM WAV `Blob` (VAD gives Float32 PCM; `/api/voice/transcribe` wants a file).
- `app/api/voice/gist/route.ts` — `POST { text }` → `condenseForSpeech(text)` → `{ text }` (gated + authed).
- `lib/voice/vad.ts` — thin wrapper over `@ricky0123/vad-web` `MicVAD`; exposes `createSpeechDetector(cb)` → `{ start, pause, destroy }`.
- `public/vad/` — vendored `silero_vad*.onnx`, ORT `*.wasm`, and the VAD audio-worklet bundle.
- `hooks/use-voice-conversation.ts` — the client state machine (the core; deps injected for testability).
- `components/voice/voice-conversation.tsx` — the full-screen overlay view (owns `useChat` + `useSpeechPlayback` + VAD, renders orb/transcript/answer/sources/controls).
- `components/voice/talk-button.tsx` — the composer entry button.
- Tests: `lib/voice/__tests__/wav.test.ts`, `app/api/voice/__tests__/gist.test.ts`, `lib/voice/__tests__/vad.test.ts`, `hooks/__tests__/use-voice-conversation.test.ts`, `components/voice/__tests__/voice-conversation.test.tsx`, `components/voice/__tests__/talk-button.test.tsx`.

**Modified:**
- `components/ui/wild-breath-field.tsx` — add optional `intensity?: number` prop (ref-mirror pattern); backward-compatible with its single caller.
- `components/chat-panel.tsx` — render `<TalkButton>` in the composer action row (gated) + mount `<VoiceConversation>` when opened.
- `package.json` — add `@ricky0123/vad-web`, `onnxruntime-web`.

---

## Task 1: WAV encoder (`lib/voice/wav.ts`)

**Files:**
- Create: `lib/voice/wav.ts`
- Test: `lib/voice/__tests__/wav.test.ts`

**Interfaces:**
- Produces: `encodeWav(pcm: Float32Array, sampleRate?: number): Blob` — default `sampleRate = 16000`; returns a `Blob` of type `audio/wav`, byte length `44 + pcm.length * 2`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/wav.test.ts
import { describe, expect, it } from 'vitest'

import { encodeWav } from '@/lib/voice/wav'

const ascii = (view: DataView, off: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(off + i))).join('')

describe('encodeWav', () => {
  it('produces a 16-bit mono WAV blob with a correct header and samples', async () => {
    const pcm = new Float32Array([0, 1, -1, 0.5])
    const blob = encodeWav(pcm, 16000)

    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + pcm.length * 2)

    const view = new DataView(await blob.arrayBuffer())
    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000) // sample rate
    expect(view.getUint16(34, true)).toBe(16) // bits/sample
    expect(ascii(view, 36, 4)).toBe('data')
    // sample clamping: +1 -> 0x7fff, -1 -> -0x8000
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(0x7fff)
    expect(view.getInt16(48, true)).toBe(-0x8000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/voice/__tests__/wav.test.ts`
Expected: FAIL — `encodeWav` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/voice/wav.ts
// Encode mono Float32 PCM in [-1, 1] as a 16-bit PCM WAV Blob. The browser
// Silero VAD hands us raw Float32 PCM @16kHz; /api/voice/transcribe wants a
// file, and Whisper reads WAV via the OpenAI transcription contract.
export function encodeWav(pcm: Float32Array, sampleRate = 16000): Blob {
  const frames = pcm.length
  const buffer = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate (mono, 2 bytes/sample)
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeStr(36, 'data')
  view.setUint32(40, frames * 2, true)
  let off = 44
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/voice/__tests__/wav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/voice/wav.ts lib/voice/__tests__/wav.test.ts
git commit -m "feat(voice): WAV encoder for VAD-captured turns"
```

---

## Task 2: Gist endpoint (`/api/voice/gist`)

**Files:**
- Create: `app/api/voice/gist/route.ts`
- Test: `app/api/voice/__tests__/gist.test.ts`

**Interfaces:**
- Consumes: `condenseForSpeech(answerText: string, opts?: { abortSignal?: AbortSignal }): Promise<string>` from `lib/voice/spoken-gist.ts` (never throws; granite 2–3 sentences, falls back to `firstSentences`). `isVoiceEnabled()` from `lib/voice/config.ts`. `getCurrentUserId()` from `lib/auth/get-current-user.ts`.
- Produces: `POST /api/voice/gist` — request JSON `{ text: string }`; responses: `404` (voice off), `401` (no user), `400` (`'Bad request'` bad JSON / `'Invalid text'` empty or >20000), `200` JSON `{ text: string }`, `503` (`'Gist unavailable'`).

- [ ] **Step 1: Write the failing test**

```ts
// app/api/voice/__tests__/gist.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('@/lib/voice/config', () => ({ isVoiceEnabled: vi.fn() }))
vi.mock('@/lib/voice/spoken-gist', () => ({ condenseForSpeech: vi.fn() }))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { condenseForSpeech } from '@/lib/voice/spoken-gist'

import { POST } from '../gist/route'

const req = (body: unknown, raw = false) =>
  new Request('http://x/api/voice/gist', {
    method: 'POST',
    body: raw ? (body as string) : JSON.stringify(body)
  })

describe('POST /api/voice/gist', () => {
  beforeEach(() => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(condenseForSpeech).mockResolvedValue('Short spoken gist.')
  })

  it('404s when voice is disabled', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(false)
    expect((await POST(req({ text: 'hi' }))).status).toBe(404)
  })

  it('401s when unauthenticated', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(null)
    expect((await POST(req({ text: 'hi' }))).status).toBe(401)
  })

  it('400s on bad JSON, empty, or oversized text', async () => {
    expect((await POST(req('not json', true))).status).toBe(400)
    expect((await POST(req({ text: '' }))).status).toBe(400)
    expect((await POST(req({ text: 'x'.repeat(20001) }))).status).toBe(400)
  })

  it('200s with the condensed gist', async () => {
    const res = await POST(req({ text: 'A long answer to condense.' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'Short spoken gist.' })
    expect(condenseForSpeech).toHaveBeenCalledWith('A long answer to condense.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test app/api/voice/__tests__/gist.test.ts`
Expected: FAIL — cannot import `../gist/route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/api/voice/gist/route.ts
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { condenseForSpeech } from '@/lib/voice/spoken-gist'

const MAX_TEXT = 20000

// Condense a finished answer into a short spoken reply for the hands-free
// conversation loop. Reuses the granite gist path (condenseForSpeech) that the
// on-screen read-aloud no longer uses. Gated + authed like the other voice routes.
export async function POST(req: Request): Promise<Response> {
  if (!isVoiceEnabled()) return new Response('Not found', { status: 404 })

  const userId = await getCurrentUserId()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let text: unknown
  try {
    ;({ text } = await req.json())
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) {
    return new Response('Invalid text', { status: 400 })
  }

  try {
    const gist = await condenseForSpeech(text)
    return new Response(JSON.stringify({ text: gist }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    })
  } catch {
    return new Response('Gist unavailable', { status: 503 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test app/api/voice/__tests__/gist.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add app/api/voice/gist/route.ts app/api/voice/__tests__/gist.test.ts
git commit -m "feat(voice): /api/voice/gist — condensed spoken reply for the loop"
```

---

## Task 3: VAD dependency, vendored assets, and wrapper (`lib/voice/vad.ts`)

**Files:**
- Modify: `package.json` (add deps)
- Create: `public/vad/` (vendored assets), `lib/voice/vad.ts`
- Test: `lib/voice/__tests__/vad.test.ts`

**Interfaces:**
- Consumes: `MicVAD.new(opts)` and `MicVAD.prototype.{start,pause,destroy}` from `@ricky0123/vad-web`.
- Produces:
  ```ts
  export interface SpeechDetector { start(): void; pause(): void; destroy(): void }
  export interface DetectorCallbacks {
    onSpeechStart?: () => void
    onSpeechEnd: (pcm: Float32Array) => void
  }
  export function createSpeechDetector(cb: DetectorCallbacks): Promise<SpeechDetector>
  ```

- [ ] **Step 1: Install and pin the deps**

Run:
```bash
bun add @ricky0123/vad-web onnxruntime-web
```
Then pin both to the resolved exact versions in `package.json` (replace any `^` with the exact installed version, e.g. `"@ricky0123/vad-web": "0.0.x"`, `"onnxruntime-web": "1.x.y"`) so the vendored assets always match the code. Confirm the installed API in `node_modules/@ricky0123/vad-web/dist/index.d.ts`: `MicVAD.new(options)` accepting `onSpeechStart`, `onSpeechEnd: (audio: Float32Array) => void`, `positiveSpeechThreshold`, `negativeSpeechThreshold`, `redemptionFrames`, `minSpeechFrames`, `preSpeechPadFrames`, `baseAssetPath`, `onnxWASMBasePath`, and returning an instance with `start()/pause()/destroy()`. If a name differs in the installed version, adapt the wrapper in Step 4 and note it.

- [ ] **Step 2: Vendor the runtime assets into `public/vad/`**

Run (verify the exact filenames present in each dist dir first with `ls`; copy whatever `.onnx`, `.wasm`, and `*.worklet*.js` files exist):
```bash
mkdir -p public/vad
cp node_modules/@ricky0123/vad-web/dist/*.onnx public/vad/
cp node_modules/@ricky0123/vad-web/dist/*.worklet*.js public/vad/
cp node_modules/onnxruntime-web/dist/*.wasm public/vad/
ls -1 public/vad/
```
These are served same-origin (no CDN). The existing CSP (`frame-ancestors 'none'; base-uri 'self'; object-src 'none'`) sets no `script-src`/`connect-src`, so same-origin WASM/worker/ONNX load fine — no `next.config.mjs` change.

- [ ] **Step 3: Write the failing test**

```ts
// lib/voice/__tests__/vad.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

const newMock = vi.fn()
vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: { new: newMock }
}))

import { createSpeechDetector } from '@/lib/voice/vad'

afterEach(() => vi.clearAllMocks())

describe('createSpeechDetector', () => {
  it('creates a MicVAD pointed at local assets and wires callbacks', async () => {
    const instance = { start: vi.fn(), pause: vi.fn(), destroy: vi.fn() }
    newMock.mockResolvedValue(instance)
    const onSpeechEnd = vi.fn()

    const det = await createSpeechDetector({ onSpeechEnd })

    const opts = newMock.mock.calls[0][0]
    expect(opts.baseAssetPath).toBe('/vad/')
    expect(opts.onnxWASMBasePath).toBe('/vad/')
    // the wrapper forwards VAD's Float32 PCM straight through
    const pcm = new Float32Array([0.1, 0.2])
    opts.onSpeechEnd(pcm)
    expect(onSpeechEnd).toHaveBeenCalledWith(pcm)

    det.start(); det.pause(); det.destroy()
    expect(instance.start).toHaveBeenCalled()
    expect(instance.pause).toHaveBeenCalled()
    expect(instance.destroy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run it (fail), then write the wrapper**

Run: `bun run test lib/voice/__tests__/vad.test.ts` → FAIL (module `@/lib/voice/vad` missing). Then:

```ts
// lib/voice/vad.ts
import { MicVAD } from '@ricky0123/vad-web'

export interface SpeechDetector {
  start(): void
  pause(): void
  destroy(): void
}

export interface DetectorCallbacks {
  onSpeechStart?: () => void
  onSpeechEnd: (pcm: Float32Array) => void
}

// Silence endpointing tuned for conversational turns. These are frame counts;
// with vad-web's default frame size (~96ms) redemptionFrames≈12 gives ~1.15s of
// trailing silence, minSpeechFrames≈4 ignores <~350ms blips. Calibrate against
// the installed version's frame size during the prod live-mic check.
const VAD_OPTS = {
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  redemptionFrames: 12,
  minSpeechFrames: 4,
  preSpeechPadFrames: 3,
  baseAssetPath: '/vad/',
  onnxWASMBasePath: '/vad/'
} as const

export async function createSpeechDetector(
  cb: DetectorCallbacks
): Promise<SpeechDetector> {
  const vad = await MicVAD.new({
    ...VAD_OPTS,
    onSpeechStart: cb.onSpeechStart,
    onSpeechEnd: (audio: Float32Array) => cb.onSpeechEnd(audio)
  })
  return {
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy()
  }
}
```

- [ ] **Step 5: Run test (pass), typecheck, commit**

Run: `bun run test lib/voice/__tests__/vad.test.ts` → PASS; `bun typecheck` → clean.

```bash
git add package.json bun.lock public/vad lib/voice/vad.ts lib/voice/__tests__/vad.test.ts
git commit -m "feat(voice): in-browser Silero VAD wrapper + vendored assets"
```

---

## Task 4: `WildBreathField` reacts to an `intensity` prop

**Files:**
- Modify: `components/ui/wild-breath-field.tsx`
- Test: `components/ui/__tests__/wild-breath-field.test.tsx`

**Interfaces:**
- Produces: `WildBreathField({ className?: string; intensity?: number })` — `intensity` in `[0,1]`, default `0` (0 = today's behavior exactly). Higher intensity speeds, enlarges, and brightens the orbs.

**Context:** the whole engine is one `useEffect(() => {...}, [])` (empty deps). A prop read directly inside would capture the mount value, so mirror it into a ref (exactly how `modeRef` handles theme) and read it per frame.

- [ ] **Step 1: Write the failing test**

```tsx
// components/ui/__tests__/wild-breath-field.test.tsx
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }))

import WildBreathField from '@/components/ui/wild-breath-field'

describe('WildBreathField', () => {
  it('renders a canvas and accepts an intensity prop without throwing', () => {
    const a = render(<WildBreathField />)
    expect(a.container.querySelector('canvas')).not.toBeNull()
    const b = render(<WildBreathField intensity={1} className="x" />)
    expect(b.container.querySelector('canvas')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test components/ui/__tests__/wild-breath-field.test.tsx`
Expected: FAIL — jsdom `canvas.getContext('2d')` returns `null`, so the effect throws on the first `ctx.` call (proves we must add the null-ctx guard). If the mocked `useTheme` path already returns before that, the intensity-prop typecheck still fails until Step 3.

- [ ] **Step 3: Add the prop + ref mirror + null-ctx guard + per-frame scaling**

In `components/ui/wild-breath-field.tsx`:

1. Change the signature and add the ref mirror near the existing `modeRef`:
```tsx
export function WildBreathField({
  className,
  intensity = 0
}: {
  className?: string
  intensity?: number
}) {
  const intensityRef = useRef(0)
  useEffect(() => {
    intensityRef.current = Math.max(0, Math.min(1, intensity))
  }, [intensity])
  // ...existing modeRef, refs, and the engine effect follow
```

2. Right after the context is acquired inside the engine effect, guard null (jsdom-safe + defensive):
```tsx
const ctx = canvas.getContext('2d')
if (!ctx) return
```

3. Inside `frame(...)`, apply the intensity where the sim advances and where orbs are scaled/brightened:
```tsx
const boost = 1 + intensityRef.current * 0.8 // up to +80% motion
T += DT * SPEED * boost
breathe(b, T)
advance(b, DT * SPEED * boost)
recenter(b)
// ...
const scale = Math.min(W, H) * 0.22 * (1 + intensityRef.current * 0.25)
// ...
const a = Math.min(1, (light ? DIM_LIGHT : DIM) * fade * (1 + intensityRef.current * 0.5))
```
Keep the reduced-motion single-paint path unchanged (it reads `intensityRef.current` once — fine). Everything else stays as-is; the sole caller (`chat-panel.tsx`) passes no `intensity`, so `boost=1` reproduces current behavior byte-for-byte.

- [ ] **Step 4: Run test (pass) + guard the existing caller**

Run: `bun run test components/ui/__tests__/wild-breath-field.test.tsx` → PASS.
Run: `bun run test components/__tests__/chat-panel.test.tsx` → PASS (field is mocked there; unaffected).

- [ ] **Step 5: Commit**

```bash
git add components/ui/wild-breath-field.tsx components/ui/__tests__/wild-breath-field.test.tsx
git commit -m "feat(voice): WildBreathField reacts to an intensity prop"
```

---

## Task 5: Conversation state machine (`hooks/use-voice-conversation.ts`)

**Files:**
- Create: `hooks/use-voice-conversation.ts`
- Test: `hooks/__tests__/use-voice-conversation.test.ts`

**Interfaces:**
- Consumes: `encodeWav` (Task 1); `SpeechDetector` (Task 3).
- Produces:
  ```ts
  export type ConversationPhase =
    | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'
  export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

  export interface VoiceConversationDeps {
    createDetector: (cb: {
      onSpeechStart: () => void
      onSpeechEnd: (pcm: Float32Array) => void
    }) => Promise<import('@/lib/voice/vad').SpeechDetector>
    transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>
    condense: (answer: string, signal: AbortSignal) => Promise<string>
    speak: (text: string) => Promise<void>
    stopSpeaking: () => void
    submit: (text: string) => void
    chatStatus: ChatStatus
    answer: { key: string; text: string } | null
  }
  export interface VoiceConversationApi {
    phase: ConversationPhase
    transcript: string
    errorText: string | null
    muted: boolean
    setMuted: (m: boolean) => void
    end: () => void
  }
  export function useVoiceConversation(
    active: boolean,
    deps: VoiceConversationDeps
  ): VoiceConversationApi
  ```

**Behavior:** on `active`, create the detector and enter `listening`. On `onSpeechEnd(pcm)` while `listening` and not `muted`: pause detector, `transcribing`, `encodeWav` → `transcribe`; blank/failed transcript → back to `listening` (re-arm); else store transcript, `submit(text)` → `thinking`. When `answer` arrives with a new `key` while `thinking` (and `chatStatus==='ready'`): `speaking`, `condense` → `speak`, then `listening`. `chatStatus==='error'` while `thinking` → `error` for ~1.5s → `listening`. `end()`/`active=false` → destroy detector, `stopSpeaking`, abort in-flight fetches, `idle`. `muted` pauses the detector.

- [ ] **Step 1: Write the failing tests**

```ts
// hooks/__tests__/use-voice-conversation.test.ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useVoiceConversation,
  type VoiceConversationDeps
} from '@/hooks/use-voice-conversation'

type EndCb = (pcm: Float32Array) => void

function makeDeps(over: Partial<VoiceConversationDeps> = {}) {
  const detector = { start: vi.fn(), pause: vi.fn(), destroy: vi.fn() }
  let onSpeechEnd: EndCb = () => {}
  const deps: VoiceConversationDeps = {
    createDetector: vi.fn(async cb => {
      onSpeechEnd = cb.onSpeechEnd
      return detector
    }),
    transcribe: vi.fn(async () => 'what is the capital of france'),
    condense: vi.fn(async () => 'Paris.'),
    speak: vi.fn(async () => {}),
    stopSpeaking: vi.fn(),
    submit: vi.fn(),
    chatStatus: 'ready',
    answer: null,
    ...over
  }
  return { deps, detector, fire: (pcm: Float32Array) => onSpeechEnd(pcm) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useVoiceConversation', () => {
  it('arms the detector and enters listening when active', async () => {
    const { deps, detector } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    expect(detector.start).toHaveBeenCalled()
  })

  it('transcribes a turn and submits it, entering thinking', async () => {
    const { deps, detector, fire } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))

    await act(async () => {
      fire(new Float32Array([0.2, 0.2, 0.2]))
    })
    await waitFor(() => expect(result.current.phase).toBe('thinking'))
    expect(detector.pause).toHaveBeenCalled()
    expect(deps.submit).toHaveBeenCalledWith('what is the capital of france')
    expect(result.current.transcript).toBe('what is the capital of france')
  })

  it('re-listens without submitting on a blank transcript', async () => {
    const { deps, fire } = makeDeps({ transcribe: vi.fn(async () => '   ') })
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => fire(new Float32Array([0.1])))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('speaks the condensed answer then returns to listening', async () => {
    const base = makeDeps()
    const { result, rerender } = renderHook(
      ({ d }: { d: VoiceConversationDeps }) => useVoiceConversation(true, d),
      { initialProps: { d: base.deps } }
    )
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => base.fire(new Float32Array([0.2, 0.2])))
    await waitFor(() => expect(result.current.phase).toBe('thinking'))

    // answer streams in
    rerender({ d: { ...base.deps, chatStatus: 'ready', answer: { key: 'm1', text: 'The capital is Paris.' } } })
    await waitFor(() => expect(base.deps.condense).toHaveBeenCalledWith('The capital is Paris.', expect.anything()))
    await waitFor(() => expect(base.deps.speak).toHaveBeenCalledWith('Paris.'))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
  })

  it('shows an error then re-listens when the chat errors', async () => {
    const base = makeDeps()
    const { result, rerender } = renderHook(
      ({ d }: { d: VoiceConversationDeps }) => useVoiceConversation(true, d),
      { initialProps: { d: base.deps } }
    )
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    await act(async () => base.fire(new Float32Array([0.2])))
    await waitFor(() => expect(result.current.phase).toBe('thinking'))

    rerender({ d: { ...base.deps, chatStatus: 'error', answer: null } })
    await waitFor(() => expect(result.current.phase).toBe('error'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(result.current.phase).toBe('listening')
  })

  it('tears down on end()', async () => {
    const { deps, detector } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    act(() => result.current.end())
    expect(detector.destroy).toHaveBeenCalled()
    expect(deps.stopSpeaking).toHaveBeenCalled()
    expect(result.current.phase).toBe('idle')
  })

  it('ignores speech while muted', async () => {
    const { deps, detector, fire } = makeDeps()
    const { result } = renderHook(() => useVoiceConversation(true, deps))
    await waitFor(() => expect(result.current.phase).toBe('listening'))
    act(() => result.current.setMuted(true))
    expect(detector.pause).toHaveBeenCalled()
    await act(async () => fire(new Float32Array([0.2])))
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('listening')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test hooks/__tests__/use-voice-conversation.test.ts`
Expected: FAIL — hook module missing.

- [ ] **Step 3: Implement the state machine**

```ts
// hooks/use-voice-conversation.ts
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { SpeechDetector } from '@/lib/voice/vad'
import { encodeWav } from '@/lib/voice/wav'

export type ConversationPhase =
  | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export interface VoiceConversationDeps {
  createDetector: (cb: {
    onSpeechStart: () => void
    onSpeechEnd: (pcm: Float32Array) => void
  }) => Promise<SpeechDetector>
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>
  condense: (answer: string, signal: AbortSignal) => Promise<string>
  speak: (text: string) => Promise<void>
  stopSpeaking: () => void
  submit: (text: string) => void
  chatStatus: ChatStatus
  answer: { key: string; text: string } | null
}

export interface VoiceConversationApi {
  phase: ConversationPhase
  transcript: string
  errorText: string | null
  muted: boolean
  setMuted: (m: boolean) => void
  end: () => void
}

const ERROR_HOLD_MS = 1500

export function useVoiceConversation(
  active: boolean,
  deps: VoiceConversationDeps
): VoiceConversationApi {
  const d = useRef(deps)
  d.current = deps

  const [phase, setPhaseState] = useState<ConversationPhase>('idle')
  const [transcript, setTranscript] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [muted, setMutedState] = useState(false)

  const phaseRef = useRef<ConversationPhase>('idle')
  const setPhase = useCallback((p: ConversationPhase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const detectorRef = useRef<SpeechDetector | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const spokenKeyRef = useRef<string | null>(null)
  const mutedRef = useRef(false)
  const liveRef = useRef(false)

  const listen = useCallback(() => {
    if (!liveRef.current) return
    setTranscript(prev => prev) // keep last transcript visible
    setPhase('listening')
    if (!mutedRef.current) detectorRef.current?.start()
  }, [setPhase])

  const onSpeechEnd = useCallback(
    async (pcm: Float32Array) => {
      if (phaseRef.current !== 'listening' || mutedRef.current) return
      detectorRef.current?.pause()
      setPhase('transcribing')
      const ac = new AbortController()
      abortRef.current = ac
      let text = ''
      try {
        text = (await d.current.transcribe(encodeWav(pcm), ac.signal)).trim()
      } catch {
        text = ''
      }
      if (!liveRef.current) return
      if (!text) {
        listen()
        return
      }
      setTranscript(text)
      spokenKeyRef.current = null // expect a fresh answer for this turn
      d.current.submit(text)
      setPhase('thinking')
    },
    [listen, setPhase]
  )

  // Lifecycle: arm on active, tear down on inactive/unmount.
  useEffect(() => {
    if (!active) return
    liveRef.current = true
    setErrorText(null)
    let cancelled = false
    d.current
      .createDetector({ onSpeechStart: () => {}, onSpeechEnd })
      .then(det => {
        if (cancelled) {
          det.destroy()
          return
        }
        detectorRef.current = det
        setPhase('listening')
        if (!mutedRef.current) det.start()
      })
      .catch(() => {
        setErrorText('Microphone unavailable.')
        setPhase('error')
      })
    return () => {
      cancelled = true
      liveRef.current = false
      abortRef.current?.abort()
      d.current.stopSpeaking()
      detectorRef.current?.destroy()
      detectorRef.current = null
      setPhase('idle')
    }
  }, [active, onSpeechEnd, setPhase])

  // React to the streamed answer / chat errors while thinking.
  useEffect(() => {
    if (phaseRef.current !== 'thinking') return
    if (deps.chatStatus === 'error') {
      setErrorText('Something went wrong.')
      setPhase('error')
      const t = setTimeout(() => {
        setErrorText(null)
        listen()
      }, ERROR_HOLD_MS)
      return () => clearTimeout(t)
    }
    const ans = deps.answer
    if (deps.chatStatus === 'ready' && ans && ans.key !== spokenKeyRef.current) {
      spokenKeyRef.current = ans.key
      setPhase('speaking')
      const ac = new AbortController()
      abortRef.current = ac
      ;(async () => {
        let gist = ''
        try {
          gist = (await d.current.condense(ans.text, ac.signal)).trim()
        } catch {
          gist = ''
        }
        if (!liveRef.current) return
        try {
          if (gist) await d.current.speak(gist)
        } catch {
          /* fail-open: fall through to listening */
        }
        if (liveRef.current) listen()
      })()
    }
  }, [deps.answer, deps.chatStatus, listen, setPhase])

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m
    setMutedState(m)
    if (m) detectorRef.current?.pause()
    else if (phaseRef.current === 'listening') detectorRef.current?.start()
  }, [])

  const end = useCallback(() => {
    liveRef.current = false
    abortRef.current?.abort()
    d.current.stopSpeaking()
    detectorRef.current?.destroy()
    detectorRef.current = null
    setPhase('idle')
  }, [setPhase])

  return { phase, transcript, errorText, muted, setMuted, end }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test hooks/__tests__/use-voice-conversation.test.ts`
Expected: PASS (all 7 cases). If a transition races the fake timers, wrap the triggering rerender in `act` and prefer `waitFor` over synchronous asserts.

- [ ] **Step 5: Commit**

```bash
git add hooks/use-voice-conversation.ts hooks/__tests__/use-voice-conversation.test.ts
git commit -m "feat(voice): hands-free conversation state machine"
```

---

## Task 6: Conversation overlay view (`components/voice/voice-conversation.tsx`)

**Files:**
- Create: `components/voice/voice-conversation.tsx`
- Test: `components/voice/__tests__/voice-conversation.test.tsx`

**Interfaces:**
- Consumes: `useChat` + `DefaultChatTransport` (from `@ai-sdk/react` / `ai`); `generateId` from `@/lib/db/schema`; `useSpeechPlayback`; `createSpeechDetector` (Task 3); `useVoiceConversation` (Task 5); `WildBreathField` with `intensity` (Task 4); `SourceFavicons` from `@/components/source-favicons`; the citable-source helpers.
- Produces: `export function VoiceConversation({ onClose }: { onClose: () => void }): JSX.Element` — a `fixed inset-0 z-50` overlay.

**Answer & source derivation (inside the component):**
```ts
const CITABLE = new Set(['tool-search', 'tool-fetch', 'tool-documentRetrieval'])
function lastAssistant(messages) { return [...messages].reverse().find(m => m.role === 'assistant') }
function lastText(m) { return m ? (m.parts.filter(p => p.type === 'text').at(-1)?.text ?? '') : '' }
function collectSources(m) {
  if (!m) return []
  const items = m.parts
    .filter(p => CITABLE.has(p.type) && p.state === 'output-available')
    .flatMap(p => p.output?.results ?? [])
  const seen = new Set<string>()
  return items.filter(r => r?.url && !seen.has(r.url) && seen.add(r.url))
}
```
`answer` passed to the hook: `chatStatus === 'ready' && text ? { key: msg.id, text } : null`.

- [ ] **Step 1: Write the failing test** (mock the heavy deps; assert wiring + End)

```tsx
// components/voice/__tests__/voice-conversation.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const endFn = vi.fn()
const setMuted = vi.fn()
vi.mock('@/hooks/use-voice-conversation', () => ({
  useVoiceConversation: () => ({
    phase: 'listening',
    transcript: 'hello there',
    errorText: null,
    muted: false,
    setMuted,
    end: endFn
  })
}))
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ messages: [], status: 'ready', sendMessage: vi.fn() })
}))
vi.mock('ai', () => ({ DefaultChatTransport: class {} }))
vi.mock('@/lib/db/schema', () => ({ generateId: () => 'cid' }))
vi.mock('@/hooks/use-speech-playback', () => ({
  useSpeechPlayback: () => ({ speak: vi.fn(), stop: vi.fn(), state: 'idle' })
}))
vi.mock('@/lib/voice/vad', () => ({ createSpeechDetector: vi.fn() }))
vi.mock('@/components/ui/wild-breath-field', () => ({
  __esModule: true,
  default: ({ intensity }: { intensity?: number }) => (
    <div data-testid="field" data-intensity={intensity} />
  ),
  WildBreathField: ({ intensity }: { intensity?: number }) => (
    <div data-testid="field" data-intensity={intensity} />
  )
}))
vi.mock('@/components/source-favicons', () => ({
  SourceFavicons: () => <div data-testid="sources" />
}))

import { VoiceConversation } from '@/components/voice/voice-conversation'

afterEach(() => vi.clearAllMocks())

describe('VoiceConversation', () => {
  it('renders the live transcript and the reactive field', () => {
    render(<VoiceConversation onClose={vi.fn()} />)
    expect(screen.getByText('hello there')).toBeInTheDocument()
    expect(screen.getByTestId('field')).toBeInTheDocument()
  })

  it('ends and closes on the End control', () => {
    const onClose = vi.fn()
    render(<VoiceConversation onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /end/i }))
    expect(endFn).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test components/voice/__tests__/voice-conversation.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Implement the view**

```tsx
// components/voice/voice-conversation.tsx
'use client'

import { useMemo, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { IconMicrophone, IconMicrophoneOff, IconX } from '@tabler/icons-react'

import { SourceFavicons } from '@/components/source-favicons'
import WildBreathField from '@/components/ui/wild-breath-field'
import { useSpeechPlayback } from '@/hooks/use-speech-playback'
import { useVoiceConversation } from '@/hooks/use-voice-conversation'
import { generateId } from '@/lib/db/schema'
import { getDistinctId } from '@/lib/analytics' // if unavailable, drop analyticsId from the body
import { createSpeechDetector } from '@/lib/voice/vad'

const CITABLE = new Set(['tool-search', 'tool-fetch', 'tool-documentRetrieval'])
const INTENSITY: Record<string, number> = {
  idle: 0, listening: 0.5, transcribing: 0.5, thinking: 0.85, speaking: 1, error: 0.2
}

export function VoiceConversation({ onClose }: { onClose: () => void }) {
  const [chatId] = useState(generateId)
  const { speak, stop } = useSpeechPlayback()

  const { messages, status, sendMessage } = useChat({
    id: chatId,
    messages: [],
    transport: new DefaultChatTransport({
      api: '/api/chat',
      prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
        body: {
          trigger,
          chatId,
          messageId,
          voice: false, // the loop uses /api/voice/gist, not the stream gist
          message: trigger === 'submit-message' ? messages[messages.length - 1] : undefined,
          isNewChat: trigger === 'submit-message' && messages.length === 1
        }
      })
    }),
    generateId
  })

  const assistant = useMemo(
    () => [...messages].reverse().find(m => m.role === 'assistant'),
    [messages]
  )
  const answerText = useMemo(
    () => assistant?.parts.filter(p => p.type === 'text').at(-1)?.text ?? '',
    [assistant]
  )
  const sources = useMemo(() => {
    if (!assistant) return []
    const seen = new Set<string>()
    return assistant.parts
      .filter((p: any) => CITABLE.has(p.type) && p.state === 'output-available')
      .flatMap((p: any) => p.output?.results ?? [])
      .filter((r: any) => r?.url && !seen.has(r.url) && seen.add(r.url))
  }, [assistant])

  const answer = useMemo(
    () =>
      status === 'ready' && assistant && answerText
        ? { key: assistant.id, text: answerText }
        : null,
    [status, assistant, answerText]
  )

  const conv = useVoiceConversation(true, {
    createDetector: cb => createSpeechDetector(cb),
    transcribe: async (wav, signal) => {
      const fd = new FormData()
      fd.append('file', wav, 'turn.wav')
      const r = await fetch('/api/voice/transcribe', { method: 'POST', body: fd, signal })
      if (!r.ok) return ''
      const { text } = await r.json()
      return typeof text === 'string' ? text : ''
    },
    condense: async (text, signal) => {
      const r = await fetch('/api/voice/gist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal
      })
      if (!r.ok) return ''
      const { text: gist } = await r.json()
      return typeof gist === 'string' ? gist : ''
    },
    speak,
    stopSpeaking: stop,
    submit: text => sendMessage({ role: 'user', parts: [{ type: 'text', text }] }),
    chatStatus: status as any,
    answer
  })

  const handleEnd = () => {
    conv.end()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl">
      <WildBreathField className="pointer-events-none absolute inset-0" intensity={INTENSITY[conv.phase] ?? 0} />
      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center gap-6 px-6 text-center">
        <p aria-live="polite" className="min-h-6 text-sm uppercase tracking-widest text-muted-foreground">
          {conv.errorText ?? conv.phase}
        </p>
        {conv.transcript && <p className="text-lg text-foreground/90">{conv.transcript}</p>}
        {answerText && (
          <div className="max-h-[40vh] w-full overflow-y-auto rounded-2xl bg-card/60 p-4 text-left">
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{answerText}</p>
            {sources.length > 0 && <div className="mt-3"><SourceFavicons results={sources as any} /></div>}
          </div>
        )}
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => conv.setMuted(!conv.muted)}
            aria-label={conv.muted ? 'Unmute microphone' : 'Mute microphone'}
            className="flex size-11 items-center justify-center rounded-full bg-card/70 text-foreground ring-1 ring-border"
          >
            {conv.muted ? <IconMicrophoneOff className="size-5" /> : <IconMicrophone className="size-5" />}
          </button>
          <button
            type="button"
            onClick={handleEnd}
            aria-label="End conversation"
            className="flex h-11 items-center gap-2 rounded-full bg-destructive px-5 text-destructive-foreground"
          >
            <IconX className="size-5" /> End
          </button>
        </div>
      </div>
    </div>
  )
}
```
Notes for the implementer: verify the real `useChat` transport body shape against `components/chat.tsx:161-260` and match it (add `analyticsId`/`systemInstructions` only if present there — `getDistinctId` lives in the analytics module; if the import path differs, drop `analyticsId` for v1). The `any` casts on tool parts mirror the codebase's own access of `part.output.results`; keep them narrow.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test components/voice/__tests__/voice-conversation.test.tsx` → PASS. Then `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add components/voice/voice-conversation.tsx components/voice/__tests__/voice-conversation.test.tsx
git commit -m "feat(voice): hands-free conversation overlay view"
```

---

## Task 7: Talk entry button + mount overlay in the composer

**Files:**
- Create: `components/voice/talk-button.tsx`
- Modify: `components/chat-panel.tsx`
- Test: `components/voice/__tests__/talk-button.test.tsx`, extend `components/__tests__/chat-panel.test.tsx`

**Interfaces:**
- Produces: `TalkButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean })`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/voice/__tests__/talk-button.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TalkButton } from '@/components/voice/talk-button'

describe('TalkButton', () => {
  it('calls onClick when pressed', () => {
    const onClick = vi.fn()
    render(<TalkButton onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /talk|converse/i }))
    expect(onClick).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test components/voice/__tests__/talk-button.test.tsx` → FAIL.

- [ ] **Step 3: Implement the button**

```tsx
// components/voice/talk-button.tsx
'use client'

import { IconHeadphones } from '@tabler/icons-react'

export function TalkButton({
  onClick,
  disabled
}: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Talk (hands-free conversation)"
      className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:text-foreground disabled:opacity-50"
    >
      <IconHeadphones className="size-5" />
    </button>
  )
}
```

- [ ] **Step 4: Run test (pass), then mount in the composer**

In `components/chat-panel.tsx`:
1. Imports: `import { TalkButton } from '@/components/voice/talk-button'` and `import { VoiceConversation } from '@/components/voice/voice-conversation'`.
2. Local state near the other composer state: `const [talkOpen, setTalkOpen] = useState(false)`.
3. In the composer action row, beside the existing `{voiceEnabled && (<MicButton .../>)}` block (chat-panel.tsx:917), add within the same `voiceEnabled` gate:
```tsx
<TalkButton onClick={() => setTalkOpen(true)} disabled={isLoading} />
```
4. Near the end of the component's returned JSX (top level of the fragment), mount the overlay:
```tsx
{voiceEnabled && talkOpen && (
  <VoiceConversation onClose={() => setTalkOpen(false)} />
)}
```

- [ ] **Step 5: Extend the chat-panel test to cover opening the overlay**

Add to `components/__tests__/chat-panel.test.tsx` (it already mocks router/children; mock the overlay so no VAD/useChat runs):
```tsx
vi.mock('@/components/voice/voice-conversation', () => ({
  VoiceConversation: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="voice-overlay"><button onClick={onClose}>close</button></div>
  )
}))
```
```tsx
it('opens the hands-free overlay from the Talk button', () => {
  // render ChatPanel with NEXT_PUBLIC_VOICE_ENABLED === 'true' (vi.stubEnv in beforeEach)
  fireEvent.click(screen.getByRole('button', { name: /talk/i }))
  expect(screen.getByTestId('voice-overlay')).toBeInTheDocument()
})
```
Ensure the test file stubs `process.env.NEXT_PUBLIC_VOICE_ENABLED = 'true'` (via `vi.stubEnv('NEXT_PUBLIC_VOICE_ENABLED', 'true')` in `beforeEach`, `vi.unstubAllEnvs()` in `afterEach`) so the gate renders the button.

- [ ] **Step 6: Run tests + commit**

Run: `bun run test components/voice/__tests__/talk-button.test.tsx components/__tests__/chat-panel.test.tsx` → PASS.

```bash
git add components/voice/talk-button.tsx components/chat-panel.tsx components/__tests__/chat-panel.test.tsx
git commit -m "feat(voice): Talk button opens the hands-free conversation overlay"
```

---

## Task 8: Full validation gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck** — `bun typecheck` → clean.
- [ ] **Step 2: Lint** — `bun lint` → no NEW errors (the pre-existing `recent-chats-section.tsx` `set-state-in-effect` error is prod's, unrelated; do not "fix" it here — see [[lab-reconciled-to-prod]]). Fix any lint issue introduced by this feature (e.g. import order, `react-hooks` in the new hook — the `d.current = deps` mirror is intentional; if the linter flags an effect-dep, add a scoped `// eslint-disable-next-line` with a one-line why, matching how `ask-headline.tsx` handled its rAF-deferred set-state).
- [ ] **Step 3: Full test suite** — `bun run test` → the new tests pass and no previously-passing test regresses. (12 tests are already red on this branch, identical to prod; your baseline is "no NEW failures".)
- [ ] **Step 4: Build** — `bun run build` → succeeds (this is the real deploy gate; catches SSR/`'use client'` boundary issues with the overlay + VAD).
- [ ] **Step 5: Rebuild the lab + smoke-test in the browser** (server paths + render; the live mic needs HTTPS, so it is a prod post-port check):
```bash
docker compose -p ask-stack-lab -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml build ask \
  && docker compose -p ask-stack-lab -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d ask
```
Then load `http://localhost:3742`, confirm the **Talk** button appears in the composer (requires `NEXT_PUBLIC_VOICE_ENABLED=true` in the lab `.env`), clicking it opens the overlay with the reactive orb + End control, and the console is clean. (The mic won't arm over plain http — expected.)

---

## Deferred to v1.1 (not in this plan)

- **Mic-level orb modulation during listening** ("breathe with your voice"): add an `AudioContext`/`AnalyserNode` reading the VAD's stream and feed a smoothed RMS into `WildBreathField intensity`. Needs a new `AudioContext` test mock (none exists). v1 drives `intensity` by phase only.
- **Sidebar "Talk" nav item** (`components/app-sidebar.tsx` `NAV_ITEMS`) as a second entry point.
- **Barge-in**, a spoken "stop" hotword, TTS voice selection, streaming/progressive gist playback (spec §10 v2).

## Porting (after lab validation, separate from this plan)

Once verified on the lab, port to staging then prod with `git cherry-pick -x` of this feature's commits (plus `bun add` of the two deps + the `public/vad/` assets in each worktree), rebuild each stack, and run the **prod live-mic verification** over HTTPS (getUserMedia). Set `NEXT_PUBLIC_VOICE_ENABLED`/`VOICE_ENABLED` per stack as today.

---

## Self-Review

**1. Spec coverage.** VAD auto-listen + silence endpoint → Tasks 3 + 5. Whisper transcribe reuse → Task 5 (`transcribe` dep) + Task 6 (fetch). Auto-submit on a real `chatId` via the existing stream → Task 6 (`useChat` + `sendMessage`). Condensed spoken reply (not full answer) → Task 2 (`/api/voice/gist`) + Task 5 (`condense`→`speak`). Dedicated voice-first view with reactive orb + transcript + answer + sources + End → Tasks 4 + 6. Sequential turns / detector paused off-listen → Task 5. Error handling (blank transcript re-listen, chat error, mic-denied, teardown) → Task 5 tests. Entry affordance → Task 7. Gating + HTTPS caveat → Global Constraints + Task 8. Build lab-first → Global Constraints + porting note. Covered.

**2. Placeholder scan.** No "TBD"/"add error handling"/"write tests for the above" — every code + test step is concrete. The two `any` casts in Task 6 are deliberate (match the codebase's own tool-part access) and called out.

**3. Type consistency.** `encodeWav(pcm, sampleRate?)` (Task 1) is consumed in Task 5. `SpeechDetector { start; pause; destroy }` and `createSpeechDetector(cb)` (Task 3) are consumed by Task 5's `createDetector` dep and Task 6. `VoiceConversationDeps`/`VoiceConversationApi` (Task 5) match Task 6's usage (`phase`, `transcript`, `errorText`, `muted`, `setMuted`, `end`, and the `{ key, text }` answer). `ChatStatus` union matches AI SDK's `status`. `WildBreathField({ intensity })` (Task 4) matches Task 6's `intensity={INTENSITY[phase]}`. `SourceFavicons({ results })` matches the report. Consistent.
