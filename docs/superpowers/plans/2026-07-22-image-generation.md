# Image Generation via Replicate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `generateImage` chat tool that generates images from text and edits user-attached images via Replicate, with persisted outputs and standalone image cards in the chat.

**Architecture:** A server-only Replicate client (Prefer: wait + polling) runs predictions for models described by a checked-in, capabilities-based registry. The tool joins the researcher's tool set; outputs are downloaded into uploads storage under a TTL-exempt `generated/` layout and rendered as standalone cards outside the research accordion.

**Tech Stack:** Next.js 16 / Bun / Vitest / Drizzle / zod / AI SDK `tool()` / Replicate HTTP API (no SDK dependency).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-image-generation-design.md`.
- Env: `REPLICATE_API_TOKEN` (feature gate), `REPLICATE_IMAGE_MODEL` (default `black-forest-labs/flux-1.1-pro`), `REPLICATE_IMAGE_EDIT_MODEL` (default `google/nano-banana`), `REPLICATE_MONTHLY_BUDGET` (unset/0 = unlimited), `REPLICATE_TIMEOUT_MS` (default `120000`).
- Never fetch client-supplied foreign URLs server-side; only Replicate output URLs (returned by Replicate's API) and our own `/uploads/` files are read.
- Tests: `bun run test` (Vitest). Gates before any deploy: `bun typecheck`, `bun lint`, `bun format:check`, `DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder bun run build`, full test suite.
- Commits are local; NO push to `origin/dev` and NO prod rebuild without the operator's explicit approval (established workflow).
- Live Replicate calls happen ONLY in Task 13 (two calls total), on the operator's personal token temporarily swapped into `.env`.

---

### Task 1: Replicate prediction client

**Files:**

- Create: `lib/imagegen/replicate-client.ts`
- Test: `lib/imagegen/__tests__/replicate-client.test.ts`

**Interfaces:**

- Consumes: nothing (env only).
- Produces:

  ```ts
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
  export async function runReplicatePrediction(args: {
    modelPath: string // e.g. 'black-forest-labs/flux-schnell'
    input: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<ReplicateResult>
  ```

- [ ] **Step 1: Write the failing tests** (`lib/imagegen/__tests__/replicate-client.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runReplicatePrediction } from '../replicate-client'

const okPrediction = (
  status: string,
  output: unknown = null,
  error: string | null = null
) => ({
  ok: true,
  json: async () => ({ id: 'p1', status, output, error })
})

describe('runReplicatePrediction', () => {
  beforeEach(() => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_test')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns the output URL when Prefer:wait resolves synchronously', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('succeeded', [
        'https://replicate.delivery/x/out.webp'
      ]) as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/out.webp'
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.replicate.com/v1/models/a/b/predictions')
    expect((init!.headers as Record<string, string>).Prefer).toBe('wait')
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer r8_test'
    )
  })

  it('accepts a single string output', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('succeeded', 'https://replicate.delivery/x/one.png') as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/one.png'
    })
  })

  it('polls until terminal when the sync window elapses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okPrediction('processing') as any) // create
      .mockResolvedValueOnce(okPrediction('processing') as any) // poll 1
      .mockResolvedValueOnce(
        okPrediction('succeeded', [
          'https://replicate.delivery/x/late.webp'
        ]) as any
      )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/late.webp'
    })
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      'https://api.replicate.com/v1/predictions/p1'
    )
  }, 15000)

  it.each([
    [401, 'auth'],
    [402, 'billing'],
    [422, 'model']
  ])('maps HTTP %s to errorClass %s', async (status, errorClass) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status,
      json: async () => ({ detail: 'nope' })
    } as any)
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass })
  })

  it('maps a failed prediction mentioning sensitive content to "content"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('failed', null, 'flagged as sensitive content') as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'content' })
  })

  it('times out via REPLICATE_TIMEOUT_MS', async () => {
    vi.stubEnv('REPLICATE_TIMEOUT_MS', '50')
    vi.mocked(fetch).mockResolvedValue(okPrediction('processing') as any)
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'timeout' })
  })

  it('returns network error when fetch rejects', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'network' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test lib/imagegen/__tests__/replicate-client.test.ts`
Expected: FAIL — cannot resolve `../replicate-client`.

- [ ] **Step 3: Implement** (`lib/imagegen/replicate-client.ts`)

```ts
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
      signal: args.signal
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
        signal: args.signal
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
```

- [ ] **Step 4: Run tests — expect PASS.** `bun run test lib/imagegen/__tests__/replicate-client.test.ts`

- [ ] **Step 5: Commit** — `git add lib/imagegen && git commit -m "Add server-only Replicate prediction client"`

---

### Task 2: Model registry with capabilities

**Files:**

- Create: `lib/imagegen/models/nano-banana.json`, `lib/imagegen/models/flux-1.1-pro.json`, `lib/imagegen/models/flux-schnell.json`, `lib/imagegen/models/seedream-4.json`
- Create: `lib/imagegen/registry.ts`
- Test: `lib/imagegen/__tests__/registry.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type ImageModelDef = {
    modelPath: string
    capabilities: ('generate' | 'edit')[]
    promptField: string
    imageField?: string // present iff 'edit' capable; value type per imageFieldShape
    imageFieldShape?: 'string' | 'array'
    aspectRatioField?: string
    aspectRatioValues?: string[] // subset the model accepts
    defaults: Record<string, unknown>
    costNote: string
  }
  export function listImageModels(): ImageModelDef[]
  export function getImageModel(role: 'generate' | 'edit'): ImageModelDef
  export function buildModelInput(
    model: ImageModelDef,
    args: {
      prompt: string
      baseImage?: string // data URI or https URL
      aspectRatio?: string
    }
  ): Record<string, unknown>
  ```

- [ ] **Step 1: Fetch the LIVE input schemas** (do not trust this plan's field names — verify):

```bash
tok=$(grep '^REPLICATE_API_TOKEN=' /home/nightfury/selfhosted/ask/.env | cut -d= -f2-)
for m in google/nano-banana black-forest-labs/flux-1.1-pro black-forest-labs/flux-schnell bytedance/seedream-4; do
  curl -s -H "Authorization: Bearer $tok" "https://api.replicate.com/v1/models/$m" \
    | jq '.latest_version.openapi_schema.components.schemas.Input.properties | keys'
done
```

Record for each model: the prompt field name, the image-input field name and whether it is a string or an array (nano-banana historically uses `image_input` as an array; flux-1.1-pro img2img uses `image_prompt`; seedream-4 uses `image_input` array), and the aspect-ratio field + accepted values. If `/v1/models/...` is auth-gated by the current token, the public model page `https://replicate.com/<owner>/<name>/api/schema` shows the same schema.

- [ ] **Step 2: Write the failing tests** (`lib/imagegen/__tests__/registry.test.ts`)

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildModelInput, getImageModel, listImageModels } from '../registry'

afterEach(() => vi.unstubAllEnvs())

describe('image model registry', () => {
  it('loads all four v1 models with valid capability sets', () => {
    const models = listImageModels()
    expect(models.map(m => m.modelPath).sort()).toEqual([
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'bytedance/seedream-4',
      'google/nano-banana'
    ])
    for (const m of models) {
      expect(m.capabilities.length).toBeGreaterThan(0)
      if (m.capabilities.includes('edit')) expect(m.imageField).toBeTruthy()
    }
  })

  it('resolves default roles from code defaults', () => {
    expect(getImageModel('generate').modelPath).toBe(
      'black-forest-labs/flux-1.1-pro'
    )
    expect(getImageModel('edit').modelPath).toBe('google/nano-banana')
  })

  it('honors env overrides and rejects capability mismatches', () => {
    vi.stubEnv('REPLICATE_IMAGE_MODEL', 'black-forest-labs/flux-schnell')
    expect(getImageModel('generate').modelPath).toBe(
      'black-forest-labs/flux-schnell'
    )
    // flux-schnell cannot edit → override ignored, falls back to default
    vi.stubEnv('REPLICATE_IMAGE_EDIT_MODEL', 'black-forest-labs/flux-schnell')
    expect(getImageModel('edit').modelPath).toBe('google/nano-banana')
  })

  it('builds input with prompt, base image, and clamped aspect ratio', () => {
    const edit = getImageModel('edit')
    const input = buildModelInput(edit, {
      prompt: 'make it night',
      baseImage: 'data:image/png;base64,AAAA',
      aspectRatio: '16:9'
    })
    expect(input[edit.promptField]).toBe('make it night')
    const img = input[edit.imageField!]
    expect(edit.imageFieldShape === 'array' ? (img as string[])[0] : img).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('omits unsupported aspect ratios instead of sending them', () => {
    const gen = getImageModel('generate')
    const input = buildModelInput(gen, {
      prompt: 'a fox',
      aspectRatio: 'nonsense'
    })
    if (gen.aspectRatioField)
      expect(input[gen.aspectRatioField]).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to verify failure**, then implement. Model JSON example (`nano-banana.json` — adjust fields to the live schema from Step 1):

```json
{
  "modelPath": "google/nano-banana",
  "capabilities": ["generate", "edit"],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.039/image"
}
```

`registry.ts`:

```ts
import fluxPro from './models/flux-1.1-pro.json'
import fluxSchnell from './models/flux-schnell.json'
import nanoBanana from './models/nano-banana.json'
import seedream from './models/seedream-4.json'

export type ImageModelDef = {
  modelPath: string
  capabilities: ('generate' | 'edit')[]
  promptField: string
  imageField?: string
  imageFieldShape?: 'string' | 'array'
  aspectRatioField?: string
  aspectRatioValues?: string[]
  defaults: Record<string, unknown>
  costNote: string
}

const MODELS = [nanoBanana, fluxPro, fluxSchnell, seedream] as ImageModelDef[]

const ROLE_DEFAULTS: Record<'generate' | 'edit', string> = {
  generate: 'black-forest-labs/flux-1.1-pro',
  edit: 'google/nano-banana'
}
const ROLE_ENV: Record<'generate' | 'edit', string> = {
  generate: 'REPLICATE_IMAGE_MODEL',
  edit: 'REPLICATE_IMAGE_EDIT_MODEL'
}

export function listImageModels(): ImageModelDef[] {
  return MODELS
}

export function getImageModel(role: 'generate' | 'edit'): ImageModelDef {
  const wanted = process.env[ROLE_ENV[role]]
  const pick = (path: string) =>
    MODELS.find(m => m.modelPath === path && m.capabilities.includes(role))
  // An override that names an unknown or capability-mismatched model is
  // ignored (with a warn) rather than breaking the tool.
  if (wanted) {
    const m = pick(wanted)
    if (m) return m
    console.warn(
      `[imagegen] ${ROLE_ENV[role]}=${wanted} is not ${role}-capable; using default`
    )
  }
  return pick(ROLE_DEFAULTS[role])!
}

export function buildModelInput(
  model: ImageModelDef,
  args: { prompt: string; baseImage?: string; aspectRatio?: string }
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...model.defaults }
  input[model.promptField] = args.prompt
  if (args.baseImage && model.imageField) {
    input[model.imageField] =
      model.imageFieldShape === 'array' ? [args.baseImage] : args.baseImage
  }
  if (
    args.aspectRatio &&
    model.aspectRatioField &&
    model.aspectRatioValues?.includes(args.aspectRatio)
  ) {
    input[model.aspectRatioField] = args.aspectRatio
  }
  return input
}
```

- [ ] **Step 4: Run tests — PASS.** `bun run test lib/imagegen/__tests__/registry.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "Add capabilities-based image model registry"`

---

### Task 3: Monthly budget guard (Redis)

**Files:**

- Create: `lib/imagegen/budget.ts`
- Test: `lib/imagegen/__tests__/budget.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export async function checkImageBudget(): Promise<{
    allowed: boolean
    used: number
    budget: number | null
  }>
  export async function recordImageGeneration(): Promise<void> // increments; sets 35d expiry on first incr
  ```
- Mirrors the Tavily budget in `app/api/advanced-search/route.ts` (`currentTavilyBudgetKey`, fail-closed semantics). Redis key: `replicate:budget:YYYY-MM` (UTC). Copy that file's Redis client initialization pattern (`@upstash/redis` vs local `redis` by env) into `lib/imagegen/budget.ts`; do not import from the route file.

- [ ] **Step 1: Failing tests** — mock the redis module the same way `app/api/advanced-search/__tests__` does (check that directory's existing budget tests and mirror their mocking approach). Cases: unset budget → always allowed with `budget: null` and no Redis read; under budget → allowed; at budget → not allowed; Redis error → not allowed (fail closed); `recordImageGeneration` increments and sets expiry only when the incremented value is 1.
- [ ] **Step 2: Run failing, implement, run passing.**
- [ ] **Step 3: Commit** — `git commit -m "Add Replicate monthly budget guard"`

---

### Task 4: Persist generated images into uploads storage

**Files:**

- Create: `lib/imagegen/persist-image.ts`
- Test: `lib/imagegen/__tests__/persist-image.test.ts`

**Interfaces:**

- Consumes: `lib/db/file-actions.ts` insert helper (use the same files-table insert the upload route uses — read `app/api/upload/route.ts:118-165` and call the same `dbActions`/insert function it calls, with `status: 'ready'`).
- Produces:

  ```ts
  export async function persistGeneratedImage(args: {
    sourceUrl: string // Replicate delivery URL (trusted: came from Replicate's API response)
    userId: string
    chatId?: string
    modelPath: string
  }): Promise<{ publicUrl: string; objectKey: string } | { error: string }>
  ```

- [ ] **Step 1: Failing tests** — mock `fetch` (returns bytes + content-type), mock `fs/promises`, mock the DB insert. Cases: writes to `<UPLOADS_DIR>/<userId>/generated/<chatId>/<ts>-<rand>.png` (objectKey second segment MUST be `generated` — assert it); returns `publicUrl` of `/uploads/<objectKey>`; extension follows content-type (`image/webp` → `.webp`, `image/jpeg` → `.jpg`, default `.png`); non-OK fetch → `{ error }`; DB insert failure → unlinks the written file and returns `{ error }`.
- [ ] **Step 2: Implement.** Layout: `objectKey = `${userId}/generated/${chatId ?? 'none'}/${Date.now()}-${randomUUID().slice(0, 8)}.${ext}``. Use `path.join(UPLOADS_DIR, objectKey)`+`mkdir recursive`exactly like`app/api/upload/route.ts:84-86`. `filename`for the DB row:`generated-<modelName>.png`where modelName is the path after`/`.
- [ ] **Step 3: Run passing, commit** — `git commit -m "Persist generated images under a TTL-exempt uploads layout"`

---

### Task 5: Exclude `generated/` from the TTL sweep

**Files:**

- Modify: `lib/db/file-actions.ts` (`expireIdleUploads` query, around line 246)
- Test: extend `lib/db/__tests__/file-actions.test.ts`

- [ ] **Step 1: Failing test** — in the existing `expireIdleUploads` describe block, add: a files row whose `object_key` is `u1/generated/c1/123-x.png` on an idle chat is NOT selected for expiry, while `u1/chats/c1/123-y.pdf` on the same idle chat IS. Follow the existing tests' mocking of `db.execute` in that file.
- [ ] **Step 2: Implement** — add one clause to the `WHERE` in `expireIdleUploads`:

```sql
      AND split_part(f.object_key, '/', 2) <> 'generated'
```

with the comment: `-- Generated images are chat content, not uploads: they must survive the idle sweep or old chats lose their images.`

- [ ] **Step 3: Run `bun run test lib/db/__tests__/file-actions.test.ts` — PASS. Commit** — `git commit -m "Exempt generated images from the idle-upload sweep"`

---

### Task 6: The `generateImage` tool

**Files:**

- Create: `lib/tools/generate-image.ts`
- Modify: `lib/streaming/helpers/transform-file-parts.ts` (export `resolveUploadUrl` — change `function resolveUploadUrl` to `export function resolveUploadUrl`; no behavior change)
- Test: `lib/tools/__tests__/generate-image.test.ts`

**Interfaces:**

- Consumes: `runReplicatePrediction` (Task 1), `getImageModel`/`buildModelInput` (Task 2), `checkImageBudget`/`recordImageGeneration` (Task 3), `persistGeneratedImage` (Task 4), `resolveUploadUrl` (this task).
- Produces:

  ```ts
  export function isImageGenEnabled(): boolean // !!process.env.REPLICATE_API_TOKEN
  export function createGenerateImageTool(userId: string, chatId?: string)
  // tool output (success): { imageUrl: string; modelId: string; prompt: string; aspectRatio?: string }
  // tool output (failure): { error: string }
  ```

- [ ] **Step 1: Failing tests** — mock all four consumed modules. Cases:
  1. Text-to-image: no `baseImageUrl` → uses `getImageModel('generate')`, persists, returns `{ imageUrl: '/uploads/u1/generated/c1/...', modelId, prompt }`, and calls `recordImageGeneration` exactly once.
  2. Edit: `baseImageUrl: '/uploads/u1/chats/c1/1-a.png'` → `resolveUploadUrl` resolves; file read → data URI passed via `buildModelInput`; uses `getImageModel('edit')`.
  3. Foreign-user upload `/uploads/OTHER/chats/...` → `{ error }`, no prediction call.
  4. External `https://example.com/pic.jpg` → passed through verbatim as the base image (no local read, no fetch).
  5. `http://` (non-https) external URL → `{ error }`, no prediction call.
  6. Budget exhausted → `{ error }` mentioning the budget, no prediction call.
  7. Prediction failure (`errorClass: 'billing'`) → `{ error }` with a user-appropriate message, `recordImageGeneration` NOT called.
- [ ] **Step 2: Implement** — shape follows `weatherTool` (`lib/tools/weather.ts`): `tool({ description, inputSchema, execute })`. `inputSchema`:

```ts
z.object({
  prompt: z
    .string()
    .describe(
      'What to generate, or the edit instruction when a base image is provided. Be specific and visual.'
    ),
  baseImageUrl: z
    .string()
    .optional()
    .describe(
      "URL of the user's uploaded image to use as the base for editing/transformation. Use the exact URL from the attachment context."
    ),
  aspectRatio: z
    .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
    .optional()
})
```

`execute` order: budget → resolve base image (own upload: `resolveUploadUrl` + first-segment userId guard copied from `transform-file-parts.ts:63-71`, then `fs.readFile` → `data:<mediaType>;base64,...`; https: pass through; anything else: error) → `getImageModel(baseImage ? 'edit' : 'generate')` → `buildModelInput` → `runReplicatePrediction` → on ok: `persistGeneratedImage` → `recordImageGeneration` → return success object. Error messages per class: auth → 'Image generation is misconfigured (API token rejected).', billing → 'The Replicate account is out of credit.', content → 'The request was rejected by the model's content filter.', timeout → 'Image generation timed out — try again.', others → the message.

- [ ] **Step 3: Run passing. Commit** — `git commit -m "Add the generateImage tool"`

---

### Task 7: Register the tool with the researcher

**Files:**

- Modify: `lib/types/agent.ts` (ResearcherTools, line 19-27): add `generateImage?: ReturnType<typeof createGenerateImageTool>`
- Modify: `lib/agents/researcher.ts`: tools object (line ~468) adds `...(isImageGenEnabled() && { generateImage: createGenerateImageTool(userId, currentChatId) })`; every `activeToolsList` assignment (skipSearch ~line 343, speed ~364, quality ~384, balanced ~406) appends `'generateImage'` via a shared suffix: after each assignment block is too repetitive — instead, immediately after the if/switch concludes (before the tools object is built), add:

```ts
if (isImageGenEnabled()) {
  activeToolsList.push('generateImage')
}
```

- Test: extend `lib/agents/__tests__/researcher.test.ts` if it exists (check; if not, cover via a small new test that calls the exported `getResearcherTools` (researcher.ts line 519) with and without `REPLICATE_API_TOKEN` stubbed and asserts the key's presence).
- [ ] Steps: failing test → implement → pass → commit `git commit -m "Register generateImage with the researcher when a token is configured"`.

---

### Task 8: Prompt guidance

**Files:**

- Create: `lib/agents/prompts/image-tool-guidance.ts`
- Modify: `lib/agents/researcher.ts` — after the `memoryBlock`/`recallBlock` appends (~line 460-465), add:

```ts
if (isImageGenEnabled()) {
  systemPrompt = systemPrompt + IMAGE_TOOL_GUIDANCE
}
```

- Test: `lib/agents/prompts/__tests__/image-tool-guidance.test.ts` (trivial: exports a non-empty string mentioning `generateImage` and `baseImageUrl` — guards accidental emptying).

- [ ] **Step 1: The guidance content** (`image-tool-guidance.ts`):

```ts
export const IMAGE_TOOL_GUIDANCE = `

## Image generation
You can create and edit images with the generateImage tool.
- When the user asks you to draw, generate, create, or make an image, call generateImage with a specific, visual prompt.
- When the user attached an image and asks to transform, restyle, edit, or vary it, pass that attachment's URL (shown in the attachment context) as baseImageUrl and describe the change in prompt.
- To iterate on an image you already generated this conversation, pass the generated image's URL as baseImageUrl.
- Image requests do not need a web search unless the user also asks for information.
- After the tool returns, reference the image naturally in your answer; the image itself is displayed automatically. If the tool returns an error, explain it plainly and do not pretend an image exists.`
```

- [ ] **Step 2:** failing test → implement → pass → commit `git commit -m "Teach the researcher when to call generateImage"`.

---

### Task 9: Expose attachment URLs to the model

**Files:**

- Modify: `lib/streaming/helpers/transform-file-parts.ts` (`transformPart`)
- Test: extend `lib/streaming/helpers/__tests__/transform-file-parts.test.ts`

- [ ] **Step 1: Failing test** — for an image attachment on the vision path, the transformed parts include a text part containing `URL: /uploads/<objectKey>`; same for the non-vision (VLM-text) path. Follow the file's existing test fixtures.
- [ ] **Step 2: Implement** — wherever `transformPart` emits the image file part (vision path) or the extracted-text part (non-vision path), append one text part:

```ts
{ type: 'text', text: `[Attachment ${filename} — URL: /uploads/${objectKey}]` }
```

This is what makes `baseImageUrl` reliably echoable by the model.

- [ ] **Step 3: Pass, commit** — `git commit -m "Expose attachment URLs to the model for image editing"`.

---

### Task 10: Standalone image card rendering

**Files:**

- Create: `components/generated-image-section.tsx`
- Modify: `components/render-message.tsx` — in the parts forEach, BEFORE the research-buffer branch (`part.type === 'reasoning' || ...`), add:

```ts
    } else if (part.type === 'tool-generateImage') {
      // Generated images are answer content, not research process — they
      // render standalone, never buried in the collapsed accordion.
      flushBuffer(`seg-${index}`)
      elements.push(
        <GeneratedImageSection
          key={`${messageId}-genimg-${index}`}
          part={part as any}
        />
      )
    }
```

Also add `'tool-generateImage'` as an EXCLUSION in the research-buffer condition (`part.type?.startsWith?.('tool-') && part.type !== 'tool-generateImage'`) and mirror the same exclusion in `endsInActiveResearch` (the standalone card's skeleton is the activity cue; without the exclusion the helper reports research-live and the process-section indicator never actually renders for it).

- Test: extend `components/__tests__/render-message.test.tsx` + create `components/__tests__/generated-image-section.test.tsx`

- [ ] **Step 1: Failing tests.** `generated-image-section.test.tsx`: `input-available` state → skeleton with prompt text visible; `output-available` with `{ imageUrl, modelId, prompt }` → `<img>` with `src=imageUrl` and caption text; `output-available` with `{ error }` → error text, no `<img>`. `render-message.test.tsx`: a message `[tool-search part, tool-generateImage part, heading text]` renders the research-process (containing ONLY tool-search) AND the image section as a sibling element; `endsInActiveResearch` returns false for a message ending in a `tool-generateImage` part.
- [ ] **Step 2: Implement** `generated-image-section.tsx`:

```tsx
'use client'

import { WildBreathGlyph } from './ui/wild-breath-logo'

type GenerateImageOutput =
  | { imageUrl: string; modelId: string; prompt: string; aspectRatio?: string }
  | { error: string }

export function GeneratedImageSection({ part }: { part: any }) {
  const prompt: string = part.input?.prompt ?? ''
  if (part.state !== 'output-available') {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-4 flex items-center gap-3">
        <WildBreathGlyph className="size-5 shrink-0" spin />
        <div className="min-w-0">
          <div className="h-40 w-full max-w-md rounded-lg bg-muted animate-pulse" />
          {prompt && (
            <p className="mt-2 text-xs text-muted-foreground truncate">
              {prompt}
            </p>
          )}
        </div>
      </div>
    )
  }
  const output = part.output as GenerateImageOutput
  if ('error' in output) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Image generation failed: {output.error}
      </div>
    )
  }
  return (
    <figure className="max-w-xl">
      <a href={output.imageUrl} target="_blank" rel="noopener noreferrer">
        <img
          src={output.imageUrl}
          alt={output.prompt}
          className="rounded-xl border border-border max-w-full h-auto"
        />
      </a>
      <figcaption className="mt-1.5 text-xs text-muted-foreground truncate">
        {output.prompt} · {output.modelId}
      </figcaption>
    </figure>
  )
}
```

- [ ] **Step 3: Pass, commit** — `git commit -m "Render generated images as standalone cards"`.

---

### Task 11: Classifier behavior for image requests

**Files:**

- Modify: `lib/agents/query-classifier.ts` (prompt text)
- Test: none automated (LLM judgment); verified live in Task 13.

- [ ] **Step 1:** Read the classifier prompt in `lib/agents/query-classifier.ts` (grep for the instruction block that defines skip-search cases). Add one line to the skip-search criteria: `- Requests to generate, draw, or edit an image (the assistant has an image tool; no web search is needed unless the request also asks for information).`
- [ ] **Step 2:** `bun run test` (classifier tests, if any, still pass). Commit — `git commit -m "Classify pure image requests as skip-search"`.

---

### Task 12: Env plumbing — model-manager registry + example file

**Files:**

- Modify: `selfhosted/model-manager/lib/env-schema.ts` — five new entries following the existing TAVILY entries' shape; `REPLICATE_IMAGE_MODEL` options `['black-forest-labs/flux-1.1-pro', 'black-forest-labs/flux-schnell', 'bytedance/seedream-4', 'google/nano-banana']`; `REPLICATE_IMAGE_EDIT_MODEL` options `['google/nano-banana', 'bytedance/seedream-4']` (edit-capable only — keep in sync with the registry's capability arrays, note the duplication in a comment since model-manager cannot import from the app).
- Modify: `.env.local.example` — a commented Replicate block with all five vars.
- Test: model-manager has its own test setup (`selfhosted/model-manager/lib/__tests__`) — extend its env-schema test the way TAVILY entries are covered, if they are.

- [ ] Implement → run model-manager tests → commit `git commit -m "Register Replicate env vars in model-manager and the env example"`.
- Reminder from the fleet workflow: model-manager's own container needs a separate rebuild at deploy time.

---

### Task 13: Gates, staging E2E, ship gate

- [ ] **Step 1: Full gates** — `bun typecheck && bun lint && bun format:check && bun run test` then the placeholder-DB build. All green before staging.
- [ ] **Step 2: Rebuild staging** — `docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d --build ask` (from the ask repo root).
- [ ] **Step 3: Token swap (operator pre-approved)** — copy `REPLICATE_API_TOKEN_P` from `/home/nightfury/selfhosted/image-gen/.env` over `REPLICATE_API_TOKEN` in `/home/nightfury/selfhosted/ask/.env` (keep a byte-exact copy of the original line to restore; never print either value), restart the staging container to pick it up.
- [ ] **Step 4: Two live tests via Playwright on :3739** —
  1. New chat, Balanced: "generate an image of a red fox in the snow, 16:9". Verify: skeleton card appears; final `<img>` with `/uploads/<user>/generated/...` src loads (HTTP 200); files row exists with `status='ready'`; `replicate:budget:` key incremented if a budget is set.
  2. Upload any small local PNG as an attachment, prompt: "turn this into a watercolor painting". Verify the edit path: tool part input contains `baseImageUrl`, output image renders.
     Also verify: reloading the chat shows both images (persistence); the research indicator behaved normally; no console errors beyond the known pre-existing ones.
- [ ] **Step 5: Restore the original `.env` token line**, restart staging.
- [ ] **Step 6: Commit any fixes, report results.** STOP — push to `origin/dev` and prod rebuild ONLY on the operator's explicit approval.

---

## Self-Review (completed)

- Spec coverage: client (T1), registry+capabilities (T2), budget (T3), persistence (T4), TTL exemption (T5), tool+URL safety (T6), registration (T7), prompting (T8), attachment URLs (T9), standalone rendering + indicator interplay (T10), classifier (T11), model-manager dropdowns + env example (T12), E2E on personal token + ship gate (T13). Shared-chat parity from the spec is exercised implicitly by serving through the existing `/uploads` route (T4) — no extra task.
- Placeholder scan: clean; every code step carries code, every command is exact.
- Type consistency: `ReplicateResult`, `ImageModelDef`, `persistGeneratedImage`, `createGenerateImageTool`, `isImageGenEnabled` used identically across tasks.
