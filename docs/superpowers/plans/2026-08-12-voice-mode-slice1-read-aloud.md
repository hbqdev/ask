# Voice Mode — Slice 1 (Read-Aloud) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask synthesizes a short, conversational spoken summary of each answer with a local TTS model and plays it back on demand / in voice mode, while the full written report is unchanged.

**Architecture:** A bolt-on voice layer. A local Kokoro TTS container (lab-scoped) sits behind a thin `/api/voice/speak` endpoint that streams audio. On a voice turn, after the answer completes, `granite4.1:8b` condenses the citation-free answer text into a 2–3 sentence "spoken gist" that streams to the client as a `data-spoken-gist` part; the client shows it as a caption and (in voice mode) auto-plays the TTS audio. Everything fails open — the written answer is never blocked.

**Tech Stack:** Next.js 16 App Router, Vercel AI SDK v6 (`ai`, `ai-sdk-ollama`), Vitest, Docker Compose, Kokoro-82M TTS (self-hosted).

## Global Constraints

- **Lab-first.** All work on the `flow-design` branch (`ask-flow` worktree); runs on the lab (`:3742`). Do NOT touch staging/prod. `VOICE_ENABLED` stays `false` everywhere except the lab overlay.
- **Fail open, always.** No voice failure (TTS down, gist model down, URL unset, flag off) may block or alter the written answer or throw into the chat path. Swallow + degrade.
- **No audio leaves the fleet.** TTS is the self-hosted Kokoro container only; no cloud TTS.
- **Author is Tin Tran <hbq.dev@gmail.com>, sole author. NEVER add Co-Authored-By / Claude / AI attribution** to any commit. Verify 0 attribution lines before committing.
- **Tests:** run with `bun run test` (NOT `bun test`). Typecheck `bun typecheck`, lint `bun lint` before each commit.
- **Gist model:** `granite4.1:8b` on the local host (via `localLlmBaseUrl()`), overridable by `VOICE_GIST_MODEL_ID`. 8s timeout, mirroring `lib/agents/title-generator.ts`.

---

### Task 1: Voice config module

**Files:**
- Create: `lib/voice/config.ts`
- Test: `lib/voice/__tests__/config.test.ts`

**Interfaces:**
- Produces: `isVoiceEnabled(): boolean`, `ttsServiceUrl(): string | undefined`, `ttsVoice(): string`, `gistModelId(): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/config.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { gistModelId, isVoiceEnabled, ttsServiceUrl, ttsVoice } from '../config'

const orig = { ...process.env }
afterEach(() => { process.env = { ...orig } })

describe('voice config', () => {
  it('isVoiceEnabled is true only when VOICE_ENABLED === "true"', () => {
    process.env.VOICE_ENABLED = 'true'
    expect(isVoiceEnabled()).toBe(true)
    process.env.VOICE_ENABLED = 'false'
    expect(isVoiceEnabled()).toBe(false)
    delete process.env.VOICE_ENABLED
    expect(isVoiceEnabled()).toBe(false)
  })

  it('ttsServiceUrl returns the env value or undefined', () => {
    process.env.TTS_SERVICE_URL = 'http://ask-tts-lab:8080'
    expect(ttsServiceUrl()).toBe('http://ask-tts-lab:8080')
    delete process.env.TTS_SERVICE_URL
    expect(ttsServiceUrl()).toBeUndefined()
  })

  it('ttsVoice and gistModelId have defaults, overridable by env', () => {
    delete process.env.VOICE_TTS_VOICE
    delete process.env.VOICE_GIST_MODEL_ID
    expect(ttsVoice()).toBe('af_heart')
    expect(gistModelId()).toBe('granite4.1:8b')
    process.env.VOICE_TTS_VOICE = 'am_adam'
    process.env.VOICE_GIST_MODEL_ID = 'llama3.2:3b'
    expect(ttsVoice()).toBe('am_adam')
    expect(gistModelId()).toBe('llama3.2:3b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/voice/__tests__/config.test.ts`
Expected: FAIL (module `../config` not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/voice/config.ts

// Voice is gated by a single flag so text users see zero change and the two
// endpoints stay disabled unless a deployment opts in. Off everywhere except the
// lab overlay (docker-compose.lab.yaml). Read per-call (not at import) so a lab
// env flip takes effect without a rebuild.
export function isVoiceEnabled(): boolean {
  return process.env.VOICE_ENABLED === 'true'
}

// Container-to-container URL for the self-hosted Kokoro TTS service. Unset ⇒
// voice degrades to text-only (fail open).
export function ttsServiceUrl(): string | undefined {
  return process.env.TTS_SERVICE_URL || undefined
}

// A Kokoro voice id. af_heart is a warm default; overridable per deployment.
export function ttsVoice(): string {
  return process.env.VOICE_TTS_VOICE || 'af_heart'
}

// Local model that condenses an answer into a spoken gist — the same resident
// granite4.1:8b the title generator / memory extractor use.
export function gistModelId(): string {
  return process.env.VOICE_GIST_MODEL_ID || 'granite4.1:8b'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/voice/__tests__/config.test.ts` → PASS. Then `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/voice/config.ts lib/voice/__tests__/config.test.ts
git commit -m "feat(voice): voice config module (flag, tts url, voice, gist model)"
```

---

### Task 2: `stripForSpeech` — make answer text speakable (pure)

**Files:**
- Create: `lib/voice/strip-for-speech.ts`
- Test: `lib/voice/__tests__/strip-for-speech.test.ts`

**Interfaces:**
- Produces: `stripForSpeech(text: string): string`, `firstSentences(text: string, n: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/strip-for-speech.test.ts
import { describe, expect, it } from 'vitest'
import { firstSentences, stripForSpeech } from '../strip-for-speech'

describe('stripForSpeech', () => {
  it('removes [n](#id) citation anchors but keeps the sentence', () => {
    expect(stripForSpeech('Nvidia leads the market [1](#call_abc).')).toBe(
      'Nvidia leads the market.'
    )
  })

  it('drops markdown tables entirely', () => {
    const md = 'Here is a comparison:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.'
    expect(stripForSpeech(md)).toBe('Here is a comparison: Done.')
  })

  it('strips bare URLs and markdown link syntax', () => {
    expect(stripForSpeech('See [the docs](https://x.com/y) at https://z.io.')).toBe(
      'See the docs at.'
    )
  })

  it('removes heading/bold/list markup and collapses whitespace', () => {
    expect(stripForSpeech('## Title\n\n- **Key** point\n- Another')).toBe(
      'Title Key point Another'
    )
  })
})

describe('firstSentences', () => {
  it('returns the first n sentences', () => {
    expect(firstSentences('One. Two. Three.', 2)).toBe('One. Two.')
  })
  it('returns everything if fewer than n', () => {
    expect(firstSentences('Only one.', 2)).toBe('Only one.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/voice/__tests__/strip-for-speech.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/voice/strip-for-speech.ts

// Turn written answer text into something a TTS model should read aloud: no
// citation anchors, tables, URLs, or markdown syntax. Complements
// extractIndexableText (which already removes citations) — kept independent so
// it can also clean a plain-text fallback.
export function stripForSpeech(text: string): string {
  return (
    text
      // [label](#call_id) or [label](http…) → label
      .replace(/\[([^\]]*)\]\((?:#|https?:\/\/)[^)]*\)/g, '$1')
      // whole markdown table blocks (lines that are pipe rows)
      .replace(/(?:^\s*\|.*\|\s*$\n?)+/gm, ' ')
      // bare URLs
      .replace(/https?:\/\/\S+/g, '')
      // headings, list bullets, blockquotes at line start
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+)/gm, '')
      // bold/italic/inline-code/strikethrough markers
      .replace(/(\*\*|__|\*|_|`|~~)/g, '')
      // collapse whitespace/newlines
      .replace(/\s+/g, ' ')
      // tidy a space that ends up before a period ("... at .")
      .replace(/\s+([.,!?;:])/g, '$1')
      .trim()
  )
}

// First n sentence-ish chunks — the fallback spoken text when the gist model is
// unavailable.
export function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g)
  if (!parts) return text.trim()
  return parts.slice(0, n).join('').trim()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/voice/__tests__/strip-for-speech.test.ts` → PASS. If a regex assertion is off by a space, adjust the regex (not the test's intent) until green. Then `bun typecheck`.

- [ ] **Step 5: Commit**

```bash
git add lib/voice/strip-for-speech.ts lib/voice/__tests__/strip-for-speech.test.ts
git commit -m "feat(voice): stripForSpeech + firstSentences text cleaners"
```

---

### Task 3: `condenseForSpeech` — the spoken gist (local model + fallback)

**Files:**
- Create: `lib/voice/spoken-gist.ts`
- Test: `lib/voice/__tests__/spoken-gist.test.ts`
- Reference (read for the pattern, do not modify): `lib/agents/title-generator.ts`, `lib/utils/local-llm-host.ts`, `lib/utils/fetch-with-timeout.ts`

**Interfaces:**
- Consumes: `stripForSpeech`, `firstSentences` (Task 2); `gistModelId` (Task 1)
- Produces: `condenseForSpeech(answerText: string, opts?: { abortSignal?: AbortSignal }): Promise<string>`

The model call is injected so it can be mocked in tests. Export the prompt-builder separately.

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/spoken-gist.test.ts
import { describe, expect, it, vi } from 'vitest'
import { condenseForSpeech } from '../spoken-gist'

describe('condenseForSpeech', () => {
  it('returns the model gist, cleaned for speech', async () => {
    const gen = vi.fn().mockResolvedValue('Nvidia leads [1](#x), followed by AMD.')
    const out = await condenseForSpeech('long answer...', { _generate: gen })
    expect(gen).toHaveBeenCalledOnce()
    expect(out).toBe('Nvidia leads, followed by AMD.')
  })

  it('falls back to the first 2 cleaned sentences when the model throws', async () => {
    const gen = vi.fn().mockRejectedValue(new Error('model down'))
    const answer = 'GPUs are key [1](#a). Prices rose. A third point here.'
    const out = await condenseForSpeech(answer, { _generate: gen })
    expect(out).toBe('GPUs are key. Prices rose.')
  })

  it('falls back on an empty model result', async () => {
    const gen = vi.fn().mockResolvedValue('   ')
    const out = await condenseForSpeech('First. Second. Third.', { _generate: gen })
    expect(out).toBe('First. Second.')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/voice/__tests__/spoken-gist.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// lib/voice/spoken-gist.ts
import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import { localLlmBaseUrl } from '../utils/local-llm-host'
import { gistModelId } from './config'
import { firstSentences, stripForSpeech } from './strip-for-speech'

const GIST_TIMEOUT_MS = 8000

export function buildGistPrompt(answer: string): string {
  return [
    'Summarize the following answer as 2 to 3 short sentences that will be READ ALOUD.',
    'Rules: conversational tone, like telling a friend the key finding; no citation',
    'numbers, no lists, no tables, no URLs, no markdown. Lead with the direct answer.',
    '',
    'ANSWER:',
    answer
  ].join('\n')
}

// Injectable generate fn so tests never hit a model. Default calls granite4.1:8b
// on the local host (same pattern as title-generator.ts).
type GenerateFn = (prompt: string, signal?: AbortSignal) => Promise<string>

const defaultGenerate: GenerateFn = async (prompt, signal) => {
  const ollama = createOllama({
    baseURL: localLlmBaseUrl(),
    fetch: createTimeoutFetch(GIST_TIMEOUT_MS)
  })
  const { text } = await generateText({
    model: ollama(gistModelId()),
    prompt,
    abortSignal: signal
  })
  return text
}

// Never throws — a voice-gist failure must not affect the written answer.
export async function condenseForSpeech(
  answerText: string,
  opts: { abortSignal?: AbortSignal; _generate?: GenerateFn } = {}
): Promise<string> {
  const clean = stripForSpeech(answerText)
  const generate = opts._generate ?? defaultGenerate
  try {
    const raw = await generate(buildGistPrompt(clean), opts.abortSignal)
    const gist = stripForSpeech(raw)
    if (gist) return gist
  } catch (e) {
    console.warn('[voice] gist model failed, using sentence fallback:', e)
  }
  return firstSentences(clean, 2)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/voice/__tests__/spoken-gist.test.ts` → PASS. Then `bun typecheck`.
> Note: confirm `localLlmBaseUrl` and `createTimeoutFetch` export names against the reference files; adjust imports if they differ (the default path is not exercised by tests).

- [ ] **Step 5: Commit**

```bash
git add lib/voice/spoken-gist.ts lib/voice/__tests__/spoken-gist.test.ts
git commit -m "feat(voice): condenseForSpeech spoken-gist condenser with fail-open fallback"
```

---

### Task 4: TTS client + `/api/voice/speak` streaming endpoint

**Files:**
- Create: `lib/voice/tts-client.ts`
- Create: `app/api/voice/speak/route.ts`
- Test: `lib/voice/__tests__/tts-client.test.ts`, `app/api/voice/__tests__/speak.test.ts`
- Reference: `app/api/feedback/route.ts` (POST + `getCurrentUserId` shape), `lib/auth/get-current-user.ts`

**Interfaces:**
- Consumes: `isVoiceEnabled`, `ttsServiceUrl`, `ttsVoice` (Task 1)
- Produces: `synthesizeSpeech(text: string, opts?: { voice?: string; signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>`

- [ ] **Step 1: Write the failing test (client)**

```ts
// lib/voice/__tests__/tts-client.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizeSpeech } from '../tts-client'

afterEach(() => vi.unstubAllGlobals())

describe('synthesizeSpeech', () => {
  it('POSTs text+voice to the TTS service and returns the audio stream', async () => {
    process.env.TTS_SERVICE_URL = 'http://tts:8080'
    const body = new ReadableStream()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body })
    vi.stubGlobal('fetch', fetchMock)

    const out = await synthesizeSpeech('hello', { voice: 'af_heart' })
    expect(out).toBe(body)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://tts:8080/speak')
    expect(JSON.parse(init.body)).toEqual({ text: 'hello', voice: 'af_heart' })
  })

  it('throws when TTS_SERVICE_URL is unset', async () => {
    delete process.env.TTS_SERVICE_URL
    await expect(synthesizeSpeech('hi')).rejects.toThrow(/not configured/i)
  })

  it('throws on a non-ok response', async () => {
    process.env.TTS_SERVICE_URL = 'http://tts:8080'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(synthesizeSpeech('hi')).rejects.toThrow(/503/)
  })
})
```

- [ ] **Step 2: Run it → FAIL** — `bun run test lib/voice/__tests__/tts-client.test.ts` (module not found).

- [ ] **Step 3: Implement the client**

```ts
// lib/voice/tts-client.ts
import { ttsServiceUrl, ttsVoice } from './config'

// POST text to the self-hosted Kokoro service and return its streaming audio
// body so the route can pipe it straight to the browser (progressive playback).
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; signal?: AbortSignal } = {}
): Promise<ReadableStream<Uint8Array>> {
  const base = ttsServiceUrl()
  if (!base) throw new Error('TTS service is not configured (TTS_SERVICE_URL)')

  const res = await fetch(`${base}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: opts.voice ?? ttsVoice() }),
    signal: opts.signal
  })
  if (!res.ok || !res.body) {
    throw new Error(`TTS service responded ${res.status}`)
  }
  return res.body
}
```

- [ ] **Step 4: Run it → PASS.**

- [ ] **Step 5: Write the failing test (route)**

```ts
// app/api/voice/__tests__/speak.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user', () => ({
  getCurrentUserId: vi.fn()
}))
vi.mock('@/lib/voice/tts-client', () => ({
  synthesizeSpeech: vi.fn()
}))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { synthesizeSpeech } from '@/lib/voice/tts-client'
import { POST } from '../speak/route'

const req = (body: unknown) =>
  new Request('http://x/api/voice/speak', {
    method: 'POST',
    body: JSON.stringify(body)
  })

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.VOICE_ENABLED
})

describe('POST /api/voice/speak', () => {
  it('404s when voice is disabled', async () => {
    process.env.VOICE_ENABLED = 'false'
    const res = await POST(req({ text: 'hi' }))
    expect(res.status).toBe(404)
  })

  it('401s when unauthenticated', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    const res = await POST(req({ text: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('streams audio for an authed request', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(synthesizeSpeech).mockResolvedValue(new ReadableStream())
    const res = await POST(req({ text: 'hello world' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/audio/)
  })

  it('400s on missing/oversized text', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req({ text: 'x'.repeat(5001) }))).status).toBe(400)
  })
})
```

- [ ] **Step 6: Run it → FAIL** (route module not found).

- [ ] **Step 7: Implement the route**

```ts
// app/api/voice/speak/route.ts
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { synthesizeSpeech } from '@/lib/voice/tts-client'

const MAX_TEXT = 5000

export async function POST(req: Request): Promise<Response> {
  // Feature-gated: when off, the endpoint does not exist.
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
    const audio = await synthesizeSpeech(text)
    return new Response(audio, {
      headers: {
        // Kokoro service streams mp3; adjust if the service is configured for wav.
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store'
      }
    })
  } catch (e) {
    console.warn('[voice] /speak failed:', e)
    return new Response('TTS unavailable', { status: 503 })
  }
}
```

- [ ] **Step 8: Run it → PASS.** Then `bun typecheck` and `bun lint`.

- [ ] **Step 9: Commit**

```bash
git add lib/voice/tts-client.ts app/api/voice/speak/route.ts lib/voice/__tests__/tts-client.test.ts app/api/voice/__tests__/speak.test.ts
git commit -m "feat(voice): TTS client + streaming /api/voice/speak endpoint"
```

---

### Task 5: Emit `data-spoken-gist` on voice turns

**Files:**
- Create: `lib/voice/emit-spoken-gist.ts`
- Test: `lib/voice/__tests__/emit-spoken-gist.test.ts`
- Modify: `app/api/chat/route.ts` (parse `voice?: boolean` from the request body, thread it into the stream context)
- Modify: `lib/streaming/create-chat-stream-response.ts` (after the answer completes, call `emitSpokenGist` when the turn is a voice turn)
- Reference: `lib/streaming/create-chat-stream-response.ts` around the `writer.write({ type: 'data-classifier' … })` sites and the `extractIndexableText` import.

**Interfaces:**
- Consumes: `condenseForSpeech` (Task 3)
- Produces: `emitSpokenGist(writer: { write: (part: unknown) => void }, answerText: string, opts?: { abortSignal?: AbortSignal }): Promise<void>` — writes `{ type: 'data-spoken-gist', data: { text } }`; never throws.

- [ ] **Step 1: Write the failing test**

```ts
// lib/voice/__tests__/emit-spoken-gist.test.ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('../spoken-gist', () => ({
  condenseForSpeech: vi.fn()
}))
import { condenseForSpeech } from '../spoken-gist'
import { emitSpokenGist } from '../emit-spoken-gist'

describe('emitSpokenGist', () => {
  it('writes a data-spoken-gist part with the condensed text', async () => {
    vi.mocked(condenseForSpeech).mockResolvedValue('Short spoken summary.')
    const write = vi.fn()
    await emitSpokenGist({ write }, 'the full answer')
    expect(write).toHaveBeenCalledWith({
      type: 'data-spoken-gist',
      data: { text: 'Short spoken summary.' }
    })
  })

  it('never throws and writes nothing when condensing fails', async () => {
    vi.mocked(condenseForSpeech).mockRejectedValue(new Error('boom'))
    const write = vi.fn()
    await expect(emitSpokenGist({ write }, 'x')).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('writes nothing for empty gist text', async () => {
    vi.mocked(condenseForSpeech).mockResolvedValue('')
    const write = vi.fn()
    await emitSpokenGist({ write }, 'x')
    expect(write).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it → FAIL** (module not found).

- [ ] **Step 3: Implement the emitter**

```ts
// lib/voice/emit-spoken-gist.ts
import { condenseForSpeech } from './spoken-gist'

// Condense the finished answer and stream it as a data part. Isolated + never
// throws so the streaming path stays unaffected if anything voice-related fails.
export async function emitSpokenGist(
  writer: { write: (part: unknown) => void },
  answerText: string,
  opts: { abortSignal?: AbortSignal } = {}
): Promise<void> {
  try {
    const text = await condenseForSpeech(answerText, opts)
    if (text) writer.write({ type: 'data-spoken-gist', data: { text } })
  } catch (e) {
    console.warn('[voice] emitSpokenGist failed (ignored):', e)
  }
}
```

- [ ] **Step 4: Run it → PASS.**

- [ ] **Step 5: Wire the request flag** — in `app/api/chat/route.ts`, where the body is parsed, read `voice` and pass it down to `createChatStreamResponse` (add a `voice?: boolean` field to the options object it already builds).

```ts
// app/api/chat/route.ts — at the body parse site (near message/chatId/trigger)
const voice = body.voice === true
// …thread `voice` into the createChatStreamResponse(...) call's options.
```

- [ ] **Step 6: Wire the emit** — in `lib/streaming/create-chat-stream-response.ts`, inside the `createUIMessageStream({ execute: async ({ writer }) => { … } })` callback, AFTER the answer stream is fully consumed (where the final `responseMessage` / indexable text is available), add:

```ts
// Voice turns only: stream a spoken gist of the finished answer. Import at top:
//   import { emitSpokenGist } from '@/lib/voice/emit-spoken-gist'
//   import { isVoiceEnabled } from '@/lib/voice/config'
//   (extractIndexableText is already imported)
if (voice && isVoiceEnabled()) {
  await emitSpokenGist(writer, extractIndexableText(responseMessage))
}
```

> If `responseMessage` is not in scope at that point, use the same cleaned-text source the persistence path uses (search the file for `extractIndexableText(` — reuse that variable). `voice` is the flag threaded in Step 5.

- [ ] **Step 7: Verify** — `bun run test lib/voice`, `bun typecheck`, `bun lint`. Manually confirm a normal (non-voice) turn is byte-for-byte unchanged (no `data-spoken-gist` part) by asserting `voice:false` produces no extra part in an existing streaming test if one exists; otherwise verify by reading the diff.

- [ ] **Step 8: Commit**

```bash
git add lib/voice/emit-spoken-gist.ts lib/voice/__tests__/emit-spoken-gist.test.ts app/api/chat/route.ts lib/streaming/create-chat-stream-response.ts
git commit -m "feat(voice): emit data-spoken-gist on voice turns"
```

---

### Task 6: Client — speak control, voice-mode auto-play, caption

**Files:**
- Create: `hooks/use-speech-playback.ts`
- Create: `components/voice/speak-button.tsx`
- Test: `hooks/__tests__/use-speech-playback.test.ts`, `components/voice/__tests__/speak-button.test.tsx`
- Modify: the message/answer render component (find it: `grep -rl "data-title\|render-message\|answer-section" components` — add `<SpeakButton>` next to the answer and read the `data-spoken-gist` part), and the chat state that already reads data parts.
- Reference: an existing component that consumes a `data-*` part (e.g. how `data-classifier`/`data-title` are read in `components/`), and `components/__tests__/*` for the vitest + testing-library setup.

**Interfaces:**
- Consumes: `POST /api/voice/speak` (Task 4), the `data-spoken-gist` part's `{ text }` (Task 5)
- Produces: `useSpeechPlayback(): { speak(text: string): Promise<void>; stop(): void; state: 'idle'|'loading'|'playing' }`, `<SpeakButton gistText={string} autoPlay={boolean} />`

- [ ] **Step 1: Write the failing hook test**

```ts
// hooks/__tests__/use-speech-playback.test.ts
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSpeechPlayback } from '../use-speech-playback'

afterEach(() => vi.unstubAllGlobals())

describe('useSpeechPlayback', () => {
  it('fetches audio and transitions idle → loading → playing', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }))
    // jsdom has no real audio; stub play()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined as never)

    const { result } = renderHook(() => useSpeechPlayback())
    expect(result.current.state).toBe('idle')
    await act(async () => { await result.current.speak('hello') })
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(fetch).toHaveBeenCalledWith('/api/voice/speak', expect.objectContaining({ method: 'POST' }))
  })

  it('returns to idle and does not throw when /speak fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    const { result } = renderHook(() => useSpeechPlayback())
    await act(async () => { await result.current.speak('hi') })
    expect(result.current.state).toBe('idle')
  })
})
```

- [ ] **Step 2: Run it → FAIL** (hook not found).

- [ ] **Step 3: Implement the hook**

```ts
// hooks/use-speech-playback.ts
'use client'
import { useCallback, useRef, useState } from 'react'

type PlaybackState = 'idle' | 'loading' | 'playing'

// Fetches TTS audio for a gist and plays it. Fail-quiet: any error returns to
// idle without throwing, so a TTS outage never breaks the UI.
export function useSpeechPlayback() {
  const [state, setState] = useState<PlaybackState>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const stop = useCallback(() => {
    audioRef.current?.pause()
    if (audioRef.current) audioRef.current.src = ''
    setState('idle')
  }, [])

  const speak = useCallback(async (text: string) => {
    try {
      stop()
      setState('loading')
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      })
      if (!res.ok) { setState('idle'); return }
      const url = URL.createObjectURL(await res.blob())
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => setState('idle')
      await audio.play()
      setState('playing')
    } catch {
      setState('idle')
    }
  }, [stop])

  return { speak, stop, state }
}
```

- [ ] **Step 4: Run it → PASS.**

- [ ] **Step 5: Write the failing component test**

```tsx
// components/voice/__tests__/speak-button.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const speak = vi.fn()
vi.mock('@/hooks/use-speech-playback', () => ({
  useSpeechPlayback: () => ({ speak, stop: vi.fn(), state: 'idle' })
}))
import { SpeakButton } from '../speak-button'

describe('SpeakButton', () => {
  it('speaks the gist text on click', () => {
    render(<SpeakButton gistText="hello there" autoPlay={false} />)
    fireEvent.click(screen.getByRole('button', { name: /listen|speak/i }))
    expect(speak).toHaveBeenCalledWith('hello there')
  })

  it('auto-plays when autoPlay is true and gist is present', () => {
    render(<SpeakButton gistText="auto play me" autoPlay />)
    expect(speak).toHaveBeenCalledWith('auto play me')
  })

  it('renders nothing without gist text', () => {
    const { container } = render(<SpeakButton gistText="" autoPlay={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
```

- [ ] **Step 6: Run it → FAIL** (component not found).

- [ ] **Step 7: Implement the component**

```tsx
// components/voice/speak-button.tsx
'use client'
import { useEffect } from 'react'

import { useSpeechPlayback } from '@/hooks/use-speech-playback'

// A "Listen" control shown on an answer. In voice mode (autoPlay) it plays the
// gist as soon as it arrives; otherwise it's a manual button. Renders nothing
// until there is a gist to speak.
export function SpeakButton({
  gistText,
  autoPlay
}: {
  gistText: string
  autoPlay: boolean
}) {
  const { speak, stop, state } = useSpeechPlayback()

  useEffect(() => {
    if (autoPlay && gistText) speak(gistText)
    return () => stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, gistText])

  if (!gistText) return null

  return (
    <button
      type="button"
      aria-label={state === 'playing' ? 'Stop' : 'Listen'}
      onClick={() => (state === 'playing' ? stop() : speak(gistText))}
      className="text-muted-foreground hover:text-foreground text-xs"
    >
      {state === 'playing' ? '■ Stop' : state === 'loading' ? '… Loading' : '▶ Listen'}
    </button>
  )
}
```

- [ ] **Step 8: Run it → PASS.**

- [ ] **Step 9: Mount it + a voice-mode toggle** — in the answer render component, read the `data-spoken-gist` part's `text` for the message and render `<SpeakButton gistText={gist} autoPlay={voiceMode} />` (a small `voiceMode` boolean from a toggle in the chat header, persisted in `localStorage`). Send `voice: voiceMode` in the `/api/chat` request body (the flag Task 5 reads). Show the gist text as a small caption under the answer when present. Gate the whole control on a client `VOICE_ENABLED`-equivalent (expose via `NEXT_PUBLIC_VOICE_ENABLED` or a small `/api/voice/status`), so nothing renders when voice is off.

- [ ] **Step 10: Verify** — `bun run test`, `bun typecheck`, `bun lint`, `bun run build`. Confirm a non-voice session shows no voice UI.

- [ ] **Step 11: Commit**

```bash
git add hooks/use-speech-playback.ts components/voice/speak-button.tsx hooks/__tests__/use-speech-playback.test.ts components/voice/__tests__/speak-button.test.tsx
git add <the modified render/header/chat files>
git commit -m "feat(voice): speak control, voice-mode auto-play, and gist caption"
```

---

### Task 7: Kokoro TTS lab service + lab wiring

**Files:**
- Modify: `docker-compose.lab.yaml` (add `ask-tts-lab`; set `VOICE_ENABLED=true`, `TTS_SERVICE_URL`, `NEXT_PUBLIC_VOICE_ENABLED=true` on `ask-lab`)
- Reference: how `ask-searxng-lab` / other lab services are defined in the same file.

**Interfaces:**
- Produces: a reachable `http://ask-tts-lab:8080/speak` for the app; `/health` for the compose healthcheck.

- [ ] **Step 1: Add the Kokoro service** (use a maintained Kokoro-FastAPI image that exposes `POST /speak {text,voice}` streaming audio + `GET /health`; pin a digest):

```yaml
  ask-tts-lab:
    image: ghcr.io/remsky/kokoro-fastapi-gpu:latest   # pin to a digest before merge
    container_name: ask-tts-lab
    # GPU access per the fleet's existing GPU service pattern (see reranker/embedder).
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:8080/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
    restart: unless-stopped
```

> Confirm the chosen image's actual request/response contract and adjust `tts-client.ts`'s path/body and the route's `Content-Type` to match (e.g. `/v1/audio/speech` OpenAI-style vs `/speak`). If it differs, update Task 4's client accordingly — the client is the single integration point.

- [ ] **Step 2: Wire `ask-lab` env** — add under the lab `ask` service `environment:`:

```yaml
      VOICE_ENABLED: 'true'
      NEXT_PUBLIC_VOICE_ENABLED: 'true'
      TTS_SERVICE_URL: 'http://ask-tts-lab:8080'
      # VOICE_TTS_VOICE / VOICE_GIST_MODEL_ID left to code defaults
```

- [ ] **Step 3: Bring it up on the lab and smoke-test**

```bash
cd /home/nightfury/selfhosted/ask-flow
docker compose -p ask-stack-lab -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d --build ask ask-tts-lab
curl -fsS -X POST http://localhost:3742/api/voice/speak -H 'Content-Type: application/json' \
  -H "<auth cookie/header as the lab expects>" --data '{"text":"Testing one two three."}' --output /tmp/tts.mp3
# expect a playable /tmp/tts.mp3
```

- [ ] **Step 4: Manual lab check** — type a question in voice mode on `:3742`; confirm the gist caption appears and audio plays; kill `ask-tts-lab` and confirm the written answer is unaffected (caption shows, no audio).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.lab.yaml
git commit -m "feat(voice): Kokoro TTS lab service + lab voice wiring"
```

---

## Self-Review

**Spec coverage:**
- §4.1 STT service → Slice 2 (not this plan). ✓ out of scope by design.
- §4.1 TTS service → Task 7. ✓
- §4.1 `/api/voice/speak` → Task 4. ✓
- §4.1 Gist generator → Task 3. ✓
- §4.1 `data-spoken-gist` part → Task 5. ✓
- §4.1 Client voice layer (speak/caption/auto-play) → Task 6. ✓
- §4.2 config/flags → Task 1 (+ wiring Task 7). ✓
- §5 fail-open matrix → Tasks 3 (gist fallback), 4 (route 503), 6 (hook fail-quiet), 5 (emitter never throws). ✓
- §8 testing → each task is TDD. ✓
- §9 Slice 1 scope (read-aloud, no mic) → this whole plan; mic is Slice 2. ✓

**Placeholder scan:** No "TBD/handle edge cases" — each step has real test + impl code. The two external-contract unknowns (Kokoro image endpoint shape; exact `responseMessage`/`localLlmBaseUrl` symbol names) are flagged with a concrete "confirm against reference X and adjust the single integration point" instruction, not left vague.

**Type consistency:** `condenseForSpeech(text, opts)` (Task 3) is consumed by `emitSpokenGist` (Task 5) with the same signature. `synthesizeSpeech` (Task 4) ⇄ `/api/voice/speak` ⇄ `useSpeechPlayback` all agree on `{ text }` in / audio stream out. `data-spoken-gist` shape `{ type, data:{text} }` is written in Task 5 and read in Task 6. `isVoiceEnabled/ttsServiceUrl/ttsVoice/gistModelId` (Task 1) are used with matching names throughout.

## Notes / risks carried from the spec

- Time-to-first-audio and gist quality are lab-measured (spec §10). If the after-the-answer gist feels slow, a later optimization can start condensing from the first streamed paragraph — not in this slice.
- The Kokoro image's exact API is the one real integration unknown; Task 4's `tts-client.ts` is deliberately the single place to adjust it.
