# Image Model Rotation & Task Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed per-role image model defaults with task-aware pool selection over a 28-model rotating roster (+1 premium, +3 pin-only legacy = 32 registered), with quality/retry premium escalation and model identity hidden from users.

**Architecture:** The registry (`lib/imagegen/registry.ts`) gains `tier`/`categories` on every model def and three selection functions (`pickPinnedModel`, `getPremiumModel`, `resolveImagePool`). Two new Redis-backed state modules (`rotation.ts`, `retry-tracker.ts`) follow `budget.ts`'s client pattern with in-memory fallback. The tool (`lib/tools/generate-image.ts`) wires precedence env-pin → premium (explicit quality or 4th retry) → pool round-robin, and stops returning `modelId`.

**Tech Stack:** Next.js 16 / TypeScript, Vitest, Redis (`@upstash/redis` or `redis`), Replicate HTTP API (existing no-SDK client).

**Spec:** `docs/superpowers/specs/2026-07-23-image-model-rotation-design.md` — read it before starting any task.

## Global Constraints

- NEVER add `Co-Authored-By` or any AI-attribution trailer to commits.
- Format single files with `bunx prettier --write <file>` — never `bun run format` (repo-wide).
- Tests run with `bun run test` (Vitest), never `bun test`.
- The tool's success payload must NOT contain `modelId` — model identity is hidden from the LLM and UI.
- Draft-tier models are reachable ONLY via `task: 'draft-fast'`.
- Premium = the single `tier: 'premium'` model (google/nano-banana-pro). `logo-svg` requests never escalate to premium.
- Env pins (`REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL`) disable rotation for their role; capability-mismatched pins warn and fall through (existing behavior).
- All 25 new model JSONs use the exact field names/enums in this plan — they were verified against Replicate's live schemas on 2026-07-23. Do not "fix" them from memory.

---

### Task 1: Registry types + selection functions

**Files:**

- Modify: `lib/imagegen/registry.ts`
- Modify: `lib/imagegen/models/nano-banana.json`, `lib/imagegen/models/seedream-4.json`, `lib/imagegen/models/flux-1.1-pro.json`, `lib/imagegen/models/flux-schnell.json`
- Test: `lib/imagegen/__tests__/registry.test.ts`

**Interfaces:**

- Consumes: existing `ImageModelDef`, `MODELS`, `buildModelInput`, `listImageModels`.
- Produces (later tasks rely on these exact signatures):
  - `type ImageTask = 'photoreal' | 'illustration' | 'design-text' | 'logo-svg' | 'draft-fast' | 'general'`
  - `type ImageTier = 'draft' | 'standard' | 'flagship' | 'premium'`
  - `ImageModelDef` gains `tier: ImageTier; categories: ImageTask[]`
  - `IMAGE_TASKS: readonly ImageTask[]` (for the tool's zod enum)
  - `effectiveImageTask(prompt: string, task?: ImageTask): ImageTask`
  - `pickPinnedModel(role: 'generate' | 'edit', models?: ImageModelDef[]): ImageModelDef | null`
  - `getPremiumModel(role: 'generate' | 'edit', models?: ImageModelDef[]): ImageModelDef | null`
  - `resolveImagePool(args: { role: 'generate' | 'edit'; task?: ImageTask; aspectRatio?: string; prompt: string }, models?: ImageModelDef[]): { poolKey: string; models: ImageModelDef[] }`
  - `getImageModel` and `ROLE_DEFAULTS` are REMOVED (only `lib/tools/generate-image.ts` consumed them; it is rewritten in Task 8).

- [ ] **Step 1: Update the four existing model JSONs** (registry won't typecheck until defs carry the new fields).

In each file add two lines directly after the `"capabilities"` line, and in `flux-1.1-pro.json` also change capabilities:

- `nano-banana.json`: keep `"capabilities": ["generate", "edit"],` then add `"tier": "standard",` and `"categories": ["general"],`
- `seedream-4.json`: keep capabilities, add `"tier": "standard",` and `"categories": [],` (pin-only per 2026 rule)
- `flux-1.1-pro.json`: change to `"capabilities": ["generate"],` (demoted from edit per spec) then add `"tier": "flagship",` and `"categories": [],`
- `flux-schnell.json`: keep capabilities, add `"tier": "draft",` and `"categories": [],`

- [ ] **Step 2: Write the failing tests** — replace the whole of `lib/imagegen/__tests__/registry.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildModelInput,
  effectiveImageTask,
  getPremiumModel,
  type ImageModelDef,
  listImageModels,
  pickPinnedModel,
  resolveImagePool
} from '../registry'

afterEach(() => vi.unstubAllEnvs())

// Fixture defs so pool tests do not depend on the evolving real roster.
const fx = (over: Partial<ImageModelDef>): ImageModelDef => ({
  modelPath: 'x/x',
  capabilities: ['generate'],
  tier: 'standard',
  categories: ['general'],
  promptField: 'prompt',
  defaults: {},
  costNote: '',
  ...over
})

const FIXTURES: ImageModelDef[] = [
  fx({ modelPath: 'a/gen-general', aspectRatioValues: ['1:1', '16:9'] }),
  fx({
    modelPath: 'b/gen-photo',
    categories: ['photoreal'],
    tier: 'flagship',
    aspectRatioValues: ['1:1']
  }),
  fx({
    modelPath: 'c/edit-general',
    capabilities: ['generate', 'edit'],
    imageField: 'image_input',
    imageFieldShape: 'array',
    aspectRatioValues: ['1:1', '16:9']
  }),
  fx({
    modelPath: 'd/draft',
    tier: 'draft',
    categories: ['draft-fast'],
    aspectRatioValues: ['1:1', '16:9']
  }),
  fx({ modelPath: 'e/svg', categories: ['logo-svg'] }),
  fx({
    modelPath: 'f/premium',
    tier: 'premium',
    capabilities: ['generate', 'edit'],
    imageField: 'image_input',
    imageFieldShape: 'array',
    categories: []
  }),
  fx({ modelPath: 'g/pin-only', categories: [] })
]

describe('structural validity of the real roster', () => {
  it('every model def has a valid tier, categories, and edit prerequisites', () => {
    const models = listImageModels()
    expect(models.length).toBeGreaterThanOrEqual(4)
    for (const m of models) {
      expect(['draft', 'standard', 'flagship', 'premium']).toContain(m.tier)
      expect(Array.isArray(m.categories)).toBe(true)
      expect(m.promptField).toBeTruthy()
      if (m.capabilities.includes('edit')) expect(m.imageField).toBeTruthy()
    }
  })

  it('has exactly one premium model, capable of both roles', () => {
    // Passes fully once Task 4 registers nano-banana-pro; at Task 1 the
    // roster has no premium model, so getPremiumModel returns null.
    const premiums = listImageModels().filter(m => m.tier === 'premium')
    expect(premiums.length).toBeLessThanOrEqual(1)
  })
})

describe('effectiveImageTask', () => {
  it('defaults to general, honors an explicit task, and rewrites on svg keywords', () => {
    expect(effectiveImageTask('a fox')).toBe('general')
    expect(effectiveImageTask('a fox', 'photoreal')).toBe('photoreal')
    expect(effectiveImageTask('an svg icon of a fox')).toBe('logo-svg')
    expect(effectiveImageTask('vector logo for acme', 'photoreal')).toBe(
      'logo-svg'
    )
  })
})

describe('pickPinnedModel', () => {
  it('returns null with no env pin, the pinned model when valid, null on capability mismatch', () => {
    expect(pickPinnedModel('generate', FIXTURES)).toBeNull()
    vi.stubEnv('REPLICATE_IMAGE_MODEL', 'g/pin-only')
    expect(pickPinnedModel('generate', FIXTURES)?.modelPath).toBe('g/pin-only')
    // pin-only is generate-only → invalid as an edit pin
    vi.stubEnv('REPLICATE_IMAGE_EDIT_MODEL', 'g/pin-only')
    expect(pickPinnedModel('edit', FIXTURES)).toBeNull()
  })
})

describe('getPremiumModel', () => {
  it('finds the premium model per role', () => {
    expect(getPremiumModel('generate', FIXTURES)?.modelPath).toBe('f/premium')
    expect(getPremiumModel('edit', FIXTURES)?.modelPath).toBe('f/premium')
    expect(getPremiumModel('edit', FIXTURES.slice(0, 5))).toBeNull()
  })
})

describe('resolveImagePool', () => {
  it('general pool excludes draft, premium, pin-only, and off-category models', () => {
    const { poolKey, models } = resolveImagePool(
      { role: 'generate', prompt: 'a fox' },
      FIXTURES
    )
    expect(poolKey).toBe('generate:general')
    expect(models.map(m => m.modelPath)).toEqual([
      'a/gen-general',
      'c/edit-general'
    ])
  })

  it('draft models are reachable only via task draft-fast', () => {
    const { models } = resolveImagePool(
      { role: 'generate', task: 'draft-fast', prompt: 'quick sketch' },
      FIXTURES
    )
    expect(models.map(m => m.modelPath)).toEqual(['d/draft'])
    for (const t of ['general', 'photoreal', 'logo-svg'] as const) {
      const r = resolveImagePool(
        { role: 'generate', task: t, prompt: 'x' },
        FIXTURES
      )
      expect(r.models.map(m => m.modelPath)).not.toContain('d/draft')
    }
  })

  it('svg keyword in the prompt rewrites the pool to logo-svg', () => {
    const { poolKey, models } = resolveImagePool(
      { role: 'generate', prompt: 'an SVG badge', task: 'photoreal' },
      FIXTURES
    )
    expect(poolKey).toBe('generate:logo-svg')
    expect(models.map(m => m.modelPath)).toEqual(['e/svg'])
  })

  it('edit role intersects with edit capability and falls back to the edit-capable set when the task pool is empty', () => {
    // photoreal ∩ edit-capable is empty in fixtures → fallback to general edit pool
    const { poolKey, models } = resolveImagePool(
      { role: 'edit', task: 'photoreal', prompt: 'brighten it' },
      FIXTURES
    )
    expect(poolKey).toBe('edit:general')
    expect(models.map(m => m.modelPath)).toEqual(['c/edit-general'])
  })

  it('prefers the aspect-ratio-supporting subset but keeps the pool when none support it', () => {
    const wide = resolveImagePool(
      { role: 'generate', prompt: 'a fox', aspectRatio: '16:9' },
      FIXTURES
    )
    expect(wide.models.map(m => m.modelPath)).toEqual([
      'a/gen-general',
      'c/edit-general'
    ])
    const photo = resolveImagePool(
      {
        role: 'generate',
        task: 'photoreal',
        prompt: 'a fox',
        aspectRatio: '16:9'
      },
      FIXTURES
    )
    // b/gen-photo only supports 1:1 → subset empty → pool unchanged
    expect(photo.models.map(m => m.modelPath)).toEqual(['b/gen-photo'])
  })
})

describe('buildModelInput (unchanged behavior)', () => {
  it('maps prompt, base image shape, and supported aspect ratio', () => {
    const m = fx({
      imageField: 'image_input',
      imageFieldShape: 'array',
      aspectRatioField: 'aspect_ratio',
      aspectRatioValues: ['16:9'],
      defaults: { output_format: 'png' }
    })
    const input = buildModelInput(m, {
      prompt: 'p',
      baseImage: 'data:image/png;base64,AAAA',
      aspectRatio: '16:9'
    })
    expect(input).toEqual({
      output_format: 'png',
      prompt: 'p',
      image_input: ['data:image/png;base64,AAAA'],
      aspect_ratio: '16:9'
    })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test lib/imagegen/__tests__/registry.test.ts`
Expected: FAIL — `effectiveImageTask`, `pickPinnedModel`, `getPremiumModel`, `resolveImagePool` not exported.

- [ ] **Step 4: Implement** — replace `lib/imagegen/registry.ts` with:

```ts
import fluxPro from './models/flux-1.1-pro.json'
import fluxSchnell from './models/flux-schnell.json'
import nanoBanana from './models/nano-banana.json'
import seedream from './models/seedream-4.json'

export type ImageTask =
  | 'photoreal'
  | 'illustration'
  | 'design-text'
  | 'logo-svg'
  | 'draft-fast'
  | 'general'

export type ImageTier = 'draft' | 'standard' | 'flagship' | 'premium'

export const IMAGE_TASKS = [
  'photoreal',
  'illustration',
  'design-text',
  'logo-svg',
  'draft-fast',
  'general'
] as const satisfies readonly ImageTask[]

export type ImageModelDef = {
  modelPath: string
  capabilities: ('generate' | 'edit')[]
  tier: ImageTier
  categories: ImageTask[]
  promptField: string
  imageField?: string
  imageFieldShape?: 'string' | 'array'
  aspectRatioField?: string
  aspectRatioValues?: string[]
  defaults: Record<string, unknown>
  costNote: string
}

const MODELS = [nanoBanana, fluxPro, fluxSchnell, seedream] as ImageModelDef[]

const ROLE_ENV: Record<'generate' | 'edit', string> = {
  generate: 'REPLICATE_IMAGE_MODEL',
  edit: 'REPLICATE_IMAGE_EDIT_MODEL'
}

export function listImageModels(): ImageModelDef[] {
  return MODELS
}

/**
 * The task a request should route on: an svg/vector prompt always routes to
 * logo-svg (deterministic guardrail), otherwise the researcher-declared task,
 * otherwise general.
 */
export function effectiveImageTask(
  prompt: string,
  task?: ImageTask
): ImageTask {
  if (/\b(svg|vector)\b/i.test(prompt)) return 'logo-svg'
  return task ?? 'general'
}

/**
 * Env pin: when REPLICATE_IMAGE_MODEL / REPLICATE_IMAGE_EDIT_MODEL names a
 * registered model with the required capability, that model is used and
 * rotation is disabled for the role. Unknown/mismatched pins warn and return
 * null so the caller falls through to rotation.
 */
export function pickPinnedModel(
  role: 'generate' | 'edit',
  models: ImageModelDef[] = MODELS
): ImageModelDef | null {
  const wanted = process.env[ROLE_ENV[role]]
  if (!wanted) return null
  const m = models.find(
    m => m.modelPath === wanted && m.capabilities.includes(role)
  )
  if (m) return m
  console.warn(
    `[imagegen] ${ROLE_ENV[role]}=${wanted} is not ${role}-capable; using rotation`
  )
  return null
}

export function getPremiumModel(
  role: 'generate' | 'edit',
  models: ImageModelDef[] = MODELS
): ImageModelDef | null {
  return (
    models.find(m => m.tier === 'premium' && m.capabilities.includes(role)) ??
    null
  )
}

/**
 * Resolve the rotation pool for a request. Guardrails, in order: svg keyword
 * rewrite (via effectiveImageTask), role capability, draft-tier gating (draft
 * models only via task draft-fast), empty-pool fallback to the role's general
 * pool, and aspect-ratio subset preference.
 */
export function resolveImagePool(
  args: {
    role: 'generate' | 'edit'
    task?: ImageTask
    aspectRatio?: string
    prompt: string
  },
  models: ImageModelDef[] = MODELS
): { poolKey: string; models: ImageModelDef[] } {
  const { role, aspectRatio, prompt } = args
  let task = effectiveImageTask(prompt, args.task)

  const roleCapable = models.filter(
    m => m.tier !== 'premium' && m.capabilities.includes(role)
  )
  let pool = roleCapable.filter(
    m =>
      m.categories.includes(task) &&
      (task === 'draft-fast' ? true : m.tier !== 'draft')
  )
  if (pool.length === 0) {
    // Task yields to correctness: fall back to the role's general pool (for
    // edits, any edit-capable non-draft model qualifies).
    task = 'general'
    pool = roleCapable.filter(
      m =>
        m.tier !== 'draft' &&
        (m.categories.includes('general') || role === 'edit')
    )
  }
  if (aspectRatio) {
    const supporting = pool.filter(m =>
      m.aspectRatioValues?.includes(aspectRatio)
    )
    if (supporting.length > 0) pool = supporting
  }
  return { poolKey: `${role}:${task}`, models: pool }
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

Note: `getImageModel` is intentionally removed. `lib/tools/generate-image.ts` will not compile until Task 8 — that is expected mid-plan; Tasks 1–7 gate on the registry test file only, and Task 8 restores the full-suite gate. Do NOT run `bun typecheck` as a task gate until Task 8.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test lib/imagegen/__tests__/registry.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Commit**

```bash
git add lib/imagegen/registry.ts lib/imagegen/__tests__/registry.test.ts lib/imagegen/models/nano-banana.json lib/imagegen/models/seedream-4.json lib/imagegen/models/flux-1.1-pro.json lib/imagegen/models/flux-schnell.json
git commit -m "Add tier/categories and pool selection to the image model registry"
```

---

### Task 2: Rotation state module

**Files:**

- Create: `lib/imagegen/rotation.ts`
- Test: `lib/imagegen/__tests__/rotation.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `nextRotationIndex(poolKey: string, poolSize: number): Promise<number>` — 0-based index, advances one per call per poolKey, wraps at poolSize; Redis key `imagegen:rr:<poolKey>`; in-memory fallback when Redis is unavailable.
  - Test hooks: `__setRotationClientForTests(client: { incr(key: string): Promise<number> } | null): void` (null forces the in-memory path) and `__resetRotationForTests(): void`.

- [ ] **Step 1: Write the failing test** — create `lib/imagegen/__tests__/rotation.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRotationForTests,
  __setRotationClientForTests,
  nextRotationIndex
} from '../rotation'

beforeEach(() => __resetRotationForTests())

describe('nextRotationIndex (in-memory path)', () => {
  beforeEach(() => __setRotationClientForTests(null))

  it('advances and wraps per poolKey independently', async () => {
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    expect(await nextRotationIndex('generate:general', 3)).toBe(1)
    expect(await nextRotationIndex('generate:general', 3)).toBe(2)
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    // a different pool has its own counter
    expect(await nextRotationIndex('edit:general', 3)).toBe(0)
  })

  it('returns 0 for empty or single pools without dividing by zero', async () => {
    expect(await nextRotationIndex('x', 0)).toBe(0)
    expect(await nextRotationIndex('y', 1)).toBe(0)
    expect(await nextRotationIndex('y', 1)).toBe(0)
  })
})

describe('nextRotationIndex (client path)', () => {
  it('uses the client INCR and maps 1-based counters to 0-based indexes', async () => {
    const incr = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    __setRotationClientForTests({ incr })
    expect(await nextRotationIndex('generate:general', 6)).toBe(0)
    expect(await nextRotationIndex('generate:general', 6)).toBe(1)
    expect(incr).toHaveBeenCalledWith('imagegen:rr:generate:general')
  })

  it('falls back to memory when the client throws', async () => {
    __setRotationClientForTests({
      incr: vi.fn().mockRejectedValue(new Error('down'))
    })
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    expect(await nextRotationIndex('generate:general', 3)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/imagegen/__tests__/rotation.test.ts`
Expected: FAIL — module `../rotation` not found.

- [ ] **Step 3: Implement** — create `lib/imagegen/rotation.ts`:

```ts
// Per-pool round-robin counters for image model rotation. Same Redis client
// pattern as budget.ts (Upstash REST when configured, else local redis://),
// with an in-process fallback so rotation still varies engines when Redis is
// down — degraded (resets on restart, per-process) but never broken.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

type CounterClient = { incr(key: string): Promise<number> }

let client: CounterClient | null = null
let clientInitialized = false
let clientOverridden = false
const memoryCounters = new Map<string, number>()

async function getRotationClient(): Promise<CounterClient | null> {
  if (clientOverridden || clientInitialized) return client
  clientInitialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    client = new Redis({ url, token })
    return client
  }
  try {
    const local = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await local.connect()
    client = local as unknown as CounterClient
  } catch (error) {
    console.warn('[imagegen] rotation: Redis unavailable, using memory:', error)
    client = null
  }
  return client
}

export function __setRotationClientForTests(c: CounterClient | null): void {
  client = c
  clientOverridden = true
  memoryCounters.clear()
}

export function __resetRotationForTests(): void {
  client = null
  clientInitialized = false
  clientOverridden = false
  memoryCounters.clear()
}

function nextFromMemory(key: string, poolSize: number): number {
  const n = (memoryCounters.get(key) ?? 0) + 1
  memoryCounters.set(key, n)
  return (n - 1) % poolSize
}

/**
 * 0-based rotation index for a pool. Consecutive calls on the same poolKey
 * never return the same index (poolSize >= 2), which is what makes a retry
 * land on a different engine.
 */
export async function nextRotationIndex(
  poolKey: string,
  poolSize: number
): Promise<number> {
  if (poolSize <= 1) return 0
  const key = `imagegen:rr:${poolKey}`
  const c = await getRotationClient()
  if (c) {
    try {
      const n = await c.incr(key)
      return (n - 1) % poolSize
    } catch (error) {
      console.warn('[imagegen] rotation INCR failed, using memory:', error)
    }
  }
  return nextFromMemory(key, poolSize)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/imagegen/__tests__/rotation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/imagegen/rotation.ts lib/imagegen/__tests__/rotation.test.ts
git commit -m "Add per-pool round-robin rotation state for image models"
```

---

### Task 3: Retry tracker

**Files:**

- Create: `lib/imagegen/retry-tracker.ts`
- Test: `lib/imagegen/__tests__/retry-tracker.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces:
  - `trackRetry(chatKey: string, isRetry: boolean): Promise<{ attempt: number; escalate: boolean }>` — non-retry resets the chat's counter and returns `{attempt: 0, escalate: false}`; retries 1–3 return `escalate: false`; the 4th consecutive retry returns `escalate: true` and resets. Redis key `imagegen:retry:<chatKey>`, TTL 24h, in-memory fallback.
  - Test hooks: `__setRetryClientForTests(client: { incr(k: string): Promise<number>; del(k: string): Promise<unknown>; expire(k: string, s: number): Promise<unknown> } | null): void`, `__resetRetryForTests(): void`.

- [ ] **Step 1: Write the failing test** — create `lib/imagegen/__tests__/retry-tracker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRetryForTests,
  __setRetryClientForTests,
  trackRetry
} from '../retry-tracker'

beforeEach(() => {
  __resetRetryForTests()
  __setRetryClientForTests(null) // in-memory path
})

describe('trackRetry', () => {
  it('escalates on the 4th consecutive retry, then resets', async () => {
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 2,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 3,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({ attempt: 4, escalate: true })
    // counter reset after escalation — the cycle starts over
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('a non-retry generation resets the streak', async () => {
    await trackRetry('c1', true)
    await trackRetry('c1', true)
    expect(await trackRetry('c1', false)).toEqual({
      attempt: 0,
      escalate: false
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('tracks chats independently', async () => {
    await trackRetry('c1', true)
    expect(await trackRetry('c2', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })

  it('uses the client when available and sets a TTL on the first increment', async () => {
    const incr = vi.fn().mockResolvedValue(1)
    const del = vi.fn().mockResolvedValue(1)
    const expire = vi.fn().mockResolvedValue(1)
    __setRetryClientForTests({ incr, del, expire })
    await trackRetry('c9', true)
    expect(incr).toHaveBeenCalledWith('imagegen:retry:c9')
    expect(expire).toHaveBeenCalledWith('imagegen:retry:c9', 60 * 60 * 24)
  })

  it('falls back to memory when the client throws', async () => {
    __setRetryClientForTests({
      incr: vi.fn().mockRejectedValue(new Error('down')),
      del: vi.fn().mockRejectedValue(new Error('down')),
      expire: vi.fn().mockRejectedValue(new Error('down'))
    })
    expect(await trackRetry('c1', true)).toEqual({
      attempt: 1,
      escalate: false
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/imagegen/__tests__/retry-tracker.test.ts`
Expected: FAIL — module `../retry-tracker` not found.

- [ ] **Step 3: Implement** — create `lib/imagegen/retry-tracker.ts`:

```ts
// Consecutive-retry counter per chat for premium escalation. The researcher
// marks a generation as a retry (isRetry) when the user was unhappy with the
// previous result; the 4th consecutive retry escalates to the premium model
// and the streak resets. Same Redis pattern as rotation.ts, with an
// in-process fallback map.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

export const RETRY_ESCALATION_THRESHOLD = 4
const TTL_SECONDS = 60 * 60 * 24

type RetryClient = {
  incr(key: string): Promise<number>
  del(key: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
}

let client: RetryClient | null = null
let clientInitialized = false
let clientOverridden = false
const memoryCounters = new Map<string, number>()

async function getRetryClient(): Promise<RetryClient | null> {
  if (clientOverridden || clientInitialized) return client
  clientInitialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    client = new Redis({ url, token }) as unknown as RetryClient
    return client
  }
  try {
    const local = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await local.connect()
    client = local as unknown as RetryClient
  } catch (error) {
    console.warn('[imagegen] retry: Redis unavailable, using memory:', error)
    client = null
  }
  return client
}

export function __setRetryClientForTests(c: RetryClient | null): void {
  client = c
  clientOverridden = true
  memoryCounters.clear()
}

export function __resetRetryForTests(): void {
  client = null
  clientInitialized = false
  clientOverridden = false
  memoryCounters.clear()
}

export async function trackRetry(
  chatKey: string,
  isRetry: boolean
): Promise<{ attempt: number; escalate: boolean }> {
  const key = `imagegen:retry:${chatKey}`
  const c = await getRetryClient()

  if (!isRetry) {
    if (c) {
      try {
        await c.del(key)
        return { attempt: 0, escalate: false }
      } catch {
        /* fall through to memory */
      }
    }
    memoryCounters.delete(key)
    return { attempt: 0, escalate: false }
  }

  let attempt: number | null = null
  if (c) {
    try {
      attempt = await c.incr(key)
      if (attempt === 1) await c.expire(key, TTL_SECONDS)
      if (attempt >= RETRY_ESCALATION_THRESHOLD) await c.del(key)
    } catch {
      attempt = null
    }
  }
  if (attempt === null) {
    attempt = (memoryCounters.get(key) ?? 0) + 1
    memoryCounters.set(key, attempt)
    if (attempt >= RETRY_ESCALATION_THRESHOLD) memoryCounters.delete(key)
  }
  return {
    attempt,
    escalate: attempt >= RETRY_ESCALATION_THRESHOLD
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/imagegen/__tests__/retry-tracker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/imagegen/retry-tracker.ts lib/imagegen/__tests__/retry-tracker.test.ts
git commit -m "Add consecutive-retry tracker for premium escalation"
```

---

### Task 4: Model JSONs — google family

**Files:**

- Create: `lib/imagegen/models/nano-banana-2.json`, `nano-banana-2-lite.json`, `nano-banana-pro.json`, `imagen-4.json`, `imagen-4-fast.json`, `imagen-4-ultra.json`
- Modify: `lib/imagegen/registry.ts` (imports + MODELS array)
- Test: `lib/imagegen/__tests__/registry.test.ts` (append)

**Interfaces:**

- Consumes: `ImageModelDef`, `resolveImagePool`, `getPremiumModel` from Task 1.
- Produces: six registered defs; `getPremiumModel('generate'|'edit')` resolves `google/nano-banana-pro` on the REAL roster from here on.

- [ ] **Step 1: Write the failing test** — append to `lib/imagegen/__tests__/registry.test.ts`:

```ts
describe('google family registration', () => {
  it('registers the six google models with expected pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'google/imagen-4',
      'google/imagen-4-fast',
      'google/imagen-4-ultra'
    ])
      expect(paths).toContain(p)

    expect(getPremiumModel('generate')?.modelPath).toBe(
      'google/nano-banana-pro'
    )
    expect(getPremiumModel('edit')?.modelPath).toBe('google/nano-banana-pro')

    const photo = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x'
    })
    expect(photo.models.map(m => m.modelPath)).toContain('google/imagen-4')
    expect(photo.models.map(m => m.modelPath)).not.toContain(
      'google/imagen-4-fast'
    ) // draft tier

    const draft = resolveImagePool({
      role: 'generate',
      task: 'draft-fast',
      prompt: 'x'
    })
    expect(draft.models.map(m => m.modelPath)).toContain(
      'google/nano-banana-2-lite'
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `bun run test lib/imagegen/__tests__/registry.test.ts` → FAIL (paths missing).

- [ ] **Step 3: Create the six JSONs** (exact content):

`lib/imagegen/models/nano-banana-2.json`:

```json
{
  "modelPath": "google/nano-banana-2",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["general", "photoreal"],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9"
  ],
  "defaults": { "resolution": "1K", "output_format": "png" },
  "costNote": "~$0.05/image @1K"
}
```

`lib/imagegen/models/nano-banana-2-lite.json`:

```json
{
  "modelPath": "google/nano-banana-2-lite",
  "capabilities": ["generate", "edit"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9"
  ],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.02/image"
}
```

`lib/imagegen/models/nano-banana-pro.json`:

```json
{
  "modelPath": "google/nano-banana-pro",
  "capabilities": ["generate", "edit"],
  "tier": "premium",
  "categories": [],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9",
    "21:9"
  ],
  "defaults": { "resolution": "2K", "output_format": "png" },
  "costNote": "~$0.14/image @2K"
}
```

`lib/imagegen/models/imagen-4.json`:

```json
{
  "modelPath": "google/imagen-4",
  "capabilities": ["generate"],
  "tier": "flagship",
  "categories": ["photoreal"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "9:16", "16:9", "3:4", "4:3"],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.04/image"
}
```

`lib/imagegen/models/imagen-4-fast.json`:

```json
{
  "modelPath": "google/imagen-4-fast",
  "capabilities": ["generate"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "9:16", "16:9", "3:4", "4:3"],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.02/image"
}
```

`lib/imagegen/models/imagen-4-ultra.json`:

```json
{
  "modelPath": "google/imagen-4-ultra",
  "capabilities": ["generate"],
  "tier": "flagship",
  "categories": ["photoreal"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "9:16", "16:9", "3:4", "4:3"],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.06/image"
}
```

- [ ] **Step 4: Register in `lib/imagegen/registry.ts`** — extend the imports and MODELS array:

```ts
import imagen4 from './models/imagen-4.json'
import imagen4Fast from './models/imagen-4-fast.json'
import imagen4Ultra from './models/imagen-4-ultra.json'
import nanoBanana2 from './models/nano-banana-2.json'
import nanoBanana2Lite from './models/nano-banana-2-lite.json'
import nanoBananaPro from './models/nano-banana-pro.json'
```

```ts
const MODELS = [
  nanoBanana,
  fluxPro,
  fluxSchnell,
  seedream,
  nanoBanana2,
  nanoBanana2Lite,
  nanoBananaPro,
  imagen4,
  imagen4Fast,
  imagen4Ultra
] as ImageModelDef[]
```

- [ ] **Step 5: Run to verify it passes** — `bun run test lib/imagegen/__tests__/registry.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/imagegen/models/ lib/imagegen/registry.ts lib/imagegen/__tests__/registry.test.ts
git commit -m "Register google image model family (nano-banana 2/lite/pro, imagen-4 line)"
```

---

### Task 5: Model JSONs — Black Forest Labs FLUX.2 family

**Files:**

- Create: `lib/imagegen/models/flux-2-pro.json`, `flux-2-max.json`, `flux-2-flex.json`, `flux-2-klein-4b.json`, `flux-2-klein-9b.json`
- Modify: `lib/imagegen/registry.ts`
- Test: `lib/imagegen/__tests__/registry.test.ts` (append)

**Interfaces:**

- Consumes: Task 1 exports.
- Produces: five registered defs using `input_images` / `images` array fields.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('flux-2 family registration', () => {
  it('registers the five FLUX.2 models with expected pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b'
    ])
      expect(paths).toContain(p)

    const editGeneral = resolveImagePool({ role: 'edit', prompt: 'x' })
    expect(editGeneral.models.map(m => m.modelPath)).toContain(
      'black-forest-labs/flux-2-pro'
    )
    expect(editGeneral.models.map(m => m.modelPath)).not.toContain(
      'black-forest-labs/flux-2-klein-4b'
    ) // draft tier

    const designText = resolveImagePool({
      role: 'generate',
      task: 'design-text',
      prompt: 'poster'
    })
    expect(designText.models.map(m => m.modelPath)).toContain(
      'black-forest-labs/flux-2-flex'
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails** — same command, FAIL.

- [ ] **Step 3: Create the five JSONs**:

`flux-2-pro.json`:

```json
{
  "modelPath": "black-forest-labs/flux-2-pro",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["general", "photoreal"],
  "promptField": "prompt",
  "imageField": "input_images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "16:9",
    "3:2",
    "2:3",
    "4:5",
    "5:4",
    "9:16",
    "3:4",
    "4:3"
  ],
  "defaults": { "resolution": "1 MP", "output_format": "png" },
  "costNote": "~$0.05/image @1MP"
}
```

`flux-2-max.json` — identical shape with:

```json
{
  "modelPath": "black-forest-labs/flux-2-max",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["photoreal"],
  "promptField": "prompt",
  "imageField": "input_images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "16:9",
    "3:2",
    "2:3",
    "4:5",
    "5:4",
    "9:16",
    "3:4",
    "4:3"
  ],
  "defaults": { "resolution": "1 MP", "output_format": "png" },
  "costNote": "~$0.08/image @1MP"
}
```

`flux-2-flex.json`:

```json
{
  "modelPath": "black-forest-labs/flux-2-flex",
  "capabilities": ["generate", "edit"],
  "tier": "standard",
  "categories": ["design-text"],
  "promptField": "prompt",
  "imageField": "input_images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "16:9",
    "3:2",
    "2:3",
    "4:5",
    "5:4",
    "9:16",
    "3:4",
    "4:3"
  ],
  "defaults": { "resolution": "1 MP", "output_format": "png" },
  "costNote": "~$0.06/image @1MP"
}
```

`flux-2-klein-4b.json`:

```json
{
  "modelPath": "black-forest-labs/flux-2-klein-4b",
  "capabilities": ["generate", "edit"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "imageField": "images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "1:1",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "21:9",
    "9:21",
    "match_input_image"
  ],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.009/image"
}
```

`flux-2-klein-9b.json`:

```json
{
  "modelPath": "black-forest-labs/flux-2-klein-9b",
  "capabilities": ["generate", "edit"],
  "tier": "standard",
  "categories": ["general"],
  "promptField": "prompt",
  "imageField": "images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "1:1",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "4:3",
    "3:4",
    "5:4",
    "4:5",
    "21:9",
    "9:21",
    "match_input_image"
  ],
  "defaults": { "output_format": "png" },
  "costNote": "~$0.015/image"
}
```

- [ ] **Step 4: Register** — add imports `flux2Pro`, `flux2Max`, `flux2Flex`, `flux2Klein4b`, `flux2Klein9b` and append to MODELS in that order.

- [ ] **Step 5: Run to verify it passes**, **Step 6: Commit**

```bash
git add lib/imagegen/models/ lib/imagegen/registry.ts lib/imagegen/__tests__/registry.test.ts
git commit -m "Register FLUX.2 family (pro, max, flex, klein 4b/9b)"
```

---

### Task 6: Model JSONs — ByteDance, Wan, OpenAI

**Files:**

- Create: `lib/imagegen/models/seedream-4.5.json`, `seedream-5-lite.json`, `wan-2.7-image-pro.json`, `wan-2.7-image.json`, `gpt-image-2.json`
- Modify: `lib/imagegen/registry.ts`
- Test: `lib/imagegen/__tests__/registry.test.ts` (append)

**Interfaces:** Task 1 exports; produces five registered defs (wan models have NO aspectRatioField — size-based only).

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('bytedance/wan/openai registration', () => {
  it('registers the five models; wan drops out of AR-filtered pools', () => {
    const paths = listImageModels().map(m => m.modelPath)
    for (const p of [
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'openai/gpt-image-2'
    ])
      expect(paths).toContain(p)

    const general = resolveImagePool({ role: 'generate', prompt: 'x' })
    expect(general.models.map(m => m.modelPath)).toContain('openai/gpt-image-2')

    // wan has no aspect_ratio input → excluded when a ratio is requested
    const withAr = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x',
      aspectRatio: '16:9'
    })
    expect(withAr.models.map(m => m.modelPath)).not.toContain(
      'wan-video/wan-2.7-image-pro'
    )
    const noAr = resolveImagePool({
      role: 'generate',
      task: 'photoreal',
      prompt: 'x'
    })
    expect(noAr.models.map(m => m.modelPath)).toContain(
      'wan-video/wan-2.7-image-pro'
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**.

- [ ] **Step 3: Create the five JSONs**:

`seedream-4.5.json`:

```json
{
  "modelPath": "bytedance/seedream-4.5",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["general", "photoreal"],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "4:3",
    "3:4",
    "4:5",
    "5:4",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "21:9",
    "9:21"
  ],
  "defaults": { "size": "2K" },
  "costNote": "~$0.04/image @2K"
}
```

`seedream-5-lite.json`:

```json
{
  "modelPath": "bytedance/seedream-5-lite",
  "capabilities": ["generate", "edit"],
  "tier": "standard",
  "categories": ["general", "illustration"],
  "promptField": "prompt",
  "imageField": "image_input",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "4:3",
    "3:4",
    "16:9",
    "9:16",
    "3:2",
    "2:3",
    "21:9"
  ],
  "defaults": { "size": "2K", "output_format": "png" },
  "costNote": "~$0.03/image @2K"
}
```

`wan-2.7-image-pro.json`:

```json
{
  "modelPath": "wan-video/wan-2.7-image-pro",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["photoreal"],
  "promptField": "prompt",
  "imageField": "images",
  "imageFieldShape": "array",
  "defaults": { "size": "2K" },
  "costNote": "~$0.05/image @2K"
}
```

`wan-2.7-image.json`:

```json
{
  "modelPath": "wan-video/wan-2.7-image",
  "capabilities": ["generate", "edit"],
  "tier": "standard",
  "categories": ["general"],
  "promptField": "prompt",
  "imageField": "images",
  "imageFieldShape": "array",
  "defaults": { "size": "2K" },
  "costNote": "~$0.03/image @2K"
}
```

`gpt-image-2.json` (openai_api_key stays UNSET — bills through Replicate; quality pinned for cost predictability):

```json
{
  "modelPath": "openai/gpt-image-2",
  "capabilities": ["generate", "edit"],
  "tier": "flagship",
  "categories": ["general", "design-text"],
  "promptField": "prompt",
  "imageField": "input_images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"],
  "defaults": { "quality": "medium", "output_format": "png" },
  "costNote": "~$0.05/image @medium (varies)"
}
```

- [ ] **Step 4: Register** — imports `seedream45`, `seedream5Lite`, `wan27ImagePro`, `wan27Image`, `gptImage2`; append to MODELS in that order.

- [ ] **Step 5: Run to verify it passes**, **Step 6: Commit**

```bash
git add lib/imagegen/models/ lib/imagegen/registry.ts lib/imagegen/__tests__/registry.test.ts
git commit -m "Register seedream 4.5/5-lite, wan 2.7 image pair, gpt-image-2"
```

---

### Task 7: Model JSONs — Pruna, Recraft, Bria + roster completeness

**Files:**

- Create: `lib/imagegen/models/p-image.json`, `p-image-edit.json`, `z-image-turbo.json`, `z-image.json`, `ernie-image-turbo.json`, `recraft-v4.1.json`, `recraft-v4.1-pro.json`, `recraft-v4.1-utility.json`, `recraft-v4.1-svg.json`, `bria-image-3.2.json`, `fibo.json`, `fibo-edit.json`
- Modify: `lib/imagegen/registry.ts`
- Test: `lib/imagegen/__tests__/registry.test.ts` (append)

**Interfaces:** Task 1 exports; after this task the roster is COMPLETE: 28 rotating defs + nano-banana-pro premium + 3 pin-only legacy (seedream-4, flux-1.1-pro, flux-schnell) = 32 registered.

- [ ] **Step 1: Write the failing test** — append:

```ts
describe('complete roster', () => {
  it('registers 32 models total with the final pool shapes', () => {
    expect(listImageModels().length).toBe(32)

    const svg = resolveImagePool({
      role: 'generate',
      task: 'logo-svg',
      prompt: 'acme logo'
    })
    expect(svg.models.map(m => m.modelPath)).toEqual([
      'recraft-ai/recraft-v4.1-svg'
    ])

    const illus = resolveImagePool({
      role: 'generate',
      task: 'illustration',
      prompt: 'x'
    })
    expect(illus.models.map(m => m.modelPath)).toEqual([
      'bytedance/seedream-5-lite',
      'prunaai/z-image',
      'prunaai/ernie-image-turbo',
      'bria/image-3.2'
    ])

    const editDraft = resolveImagePool({
      role: 'edit',
      task: 'draft-fast',
      prompt: 'x'
    })
    expect(editDraft.models.map(m => m.modelPath)).toEqual([
      'google/nano-banana-2-lite',
      'black-forest-labs/flux-2-klein-4b',
      'prunaai/p-image-edit'
    ])

    // fibo-edit prompts via `instruction`
    const fiboEdit = listImageModels().find(
      m => m.modelPath === 'bria/fibo-edit'
    )!
    expect(fiboEdit.promptField).toBe('instruction')
    const input = buildModelInput(fiboEdit, {
      prompt: 'remove the hat',
      baseImage: 'data:image/png;base64,AAAA'
    })
    expect(input.instruction).toBe('remove the hat')
    expect(input.image).toBe('data:image/png;base64,AAAA')
  })
})
```

- [ ] **Step 2: Run to verify it fails**.

- [ ] **Step 3: Create the twelve JSONs**:

`p-image.json`:

```json
{
  "modelPath": "prunaai/p-image",
  "capabilities": ["generate"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
  "defaults": { "aspect_ratio": "1:1" },
  "costNote": "~$0.005/image"
}
```

`p-image-edit.json`:

```json
{
  "modelPath": "prunaai/p-image-edit",
  "capabilities": ["edit"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "imageField": "images",
  "imageFieldShape": "array",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "match_input_image",
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3"
  ],
  "defaults": {},
  "costNote": "~$0.01/image"
}
```

`z-image-turbo.json`:

```json
{
  "modelPath": "prunaai/z-image-turbo",
  "capabilities": ["generate"],
  "tier": "draft",
  "categories": ["draft-fast"],
  "promptField": "prompt",
  "defaults": { "output_format": "png" },
  "costNote": "~$0.003/image"
}
```

`z-image.json`:

```json
{
  "modelPath": "prunaai/z-image",
  "capabilities": ["generate"],
  "tier": "standard",
  "categories": ["illustration"],
  "promptField": "prompt",
  "defaults": { "output_format": "png" },
  "costNote": "~$0.01/image"
}
```

`ernie-image-turbo.json`:

```json
{
  "modelPath": "prunaai/ernie-image-turbo",
  "capabilities": ["generate"],
  "tier": "standard",
  "categories": ["illustration"],
  "promptField": "prompt",
  "defaults": { "output_format": "png" },
  "costNote": "~$0.01/image"
}
```

`recraft-v4.1.json`:

```json
{
  "modelPath": "recraft-ai/recraft-v4.1",
  "capabilities": ["generate"],
  "tier": "standard",
  "categories": ["design-text"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "1:1",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "16:9",
    "9:16",
    "4:5",
    "5:4"
  ],
  "defaults": {},
  "costNote": "~$0.04/image"
}
```

`recraft-v4.1-pro.json` — same fields with `"modelPath": "recraft-ai/recraft-v4.1-pro"`, `"tier": "flagship"`, `"costNote": "~$0.08/image"`.

`recraft-v4.1-utility.json` — same fields with `"modelPath": "recraft-ai/recraft-v4.1-utility"`, `"tier": "draft"`, `"categories": ["draft-fast", "design-text"]`, `"costNote": "~$0.02/image"`.

`recraft-v4.1-svg.json` — same fields with `"modelPath": "recraft-ai/recraft-v4.1-svg"`, `"tier": "standard"`, `"categories": ["logo-svg"]`, `"costNote": "~$0.05/image (SVG output)"`.

`bria-image-3.2.json`:

```json
{
  "modelPath": "bria/image-3.2",
  "capabilities": ["generate"],
  "tier": "standard",
  "categories": ["general", "illustration"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9"
  ],
  "defaults": {},
  "costNote": "~$0.04/image"
}
```

`fibo.json`:

```json
{
  "modelPath": "bria/fibo",
  "capabilities": ["generate"],
  "tier": "standard",
  "categories": ["photoreal"],
  "promptField": "prompt",
  "aspectRatioField": "aspect_ratio",
  "aspectRatioValues": [
    "1:1",
    "2:3",
    "3:2",
    "3:4",
    "4:3",
    "4:5",
    "5:4",
    "9:16",
    "16:9"
  ],
  "defaults": {},
  "costNote": "~$0.04/image"
}
```

`fibo-edit.json`:

```json
{
  "modelPath": "bria/fibo-edit",
  "capabilities": ["edit"],
  "tier": "standard",
  "categories": ["general"],
  "promptField": "instruction",
  "imageField": "image",
  "imageFieldShape": "string",
  "defaults": {},
  "costNote": "~$0.04/image"
}
```

- [ ] **Step 4: Register** — imports `pImage`, `pImageEdit`, `zImageTurbo`, `zImage`, `ernieImageTurbo`, `recraftV41`, `recraftV41Pro`, `recraftV41Utility`, `recraftV41Svg`, `briaImage32`, `fibo`, `fiboEdit`; append to MODELS in that order. Final MODELS length: 32.

- [ ] **Step 5: Run to verify it passes** — the `illustration`/`editDraft` orderings in the test match this MODELS order; if they fail, fix the ORDER of the MODELS array (not the test).

- [ ] **Step 6: Commit**

```bash
git add lib/imagegen/models/ lib/imagegen/registry.ts lib/imagegen/__tests__/registry.test.ts
git commit -m "Register pruna, recraft, and bria model families - roster complete at 32"
```

---

### Task 8: Tool integration — selection precedence, hidden identity

**Files:**

- Modify: `lib/tools/generate-image.ts`
- Test: `lib/tools/__tests__/generate-image.test.ts` (rewrite mocks + add cases)

**Interfaces:**

- Consumes: `pickPinnedModel`, `getPremiumModel`, `resolveImagePool`, `effectiveImageTask`, `IMAGE_TASKS`, `buildModelInput` (Task 1); `nextRotationIndex` (Task 2); `trackRetry` (Task 3).
- Produces: tool input schema gains `task`, `quality`, `isRetry`; success payload is `{ imageUrl, prompt, aspectRatio? }` — **NO `modelId`**. Emits `console.log('[imagegen] generated', { chatId, objectKey, model, selection })` after persist.

- [ ] **Step 1: Update the test file** — in `lib/tools/__tests__/generate-image.test.ts`:

Replace the registry mock (lines 9–12) and add rotation/retry mocks:

```ts
vi.mock('@/lib/imagegen/registry', () => ({
  pickPinnedModel: vi.fn(),
  getPremiumModel: vi.fn(),
  resolveImagePool: vi.fn(),
  effectiveImageTask: (prompt: string, task?: string) =>
    /\b(svg|vector)\b/i.test(prompt) ? 'logo-svg' : (task ?? 'general'),
  buildModelInput: vi.fn()
}))
vi.mock('@/lib/imagegen/rotation', () => ({ nextRotationIndex: vi.fn() }))
vi.mock('@/lib/imagegen/retry-tracker', () => ({ trackRetry: vi.fn() }))
```

Replace the registry import (line 36) and add:

```ts
import {
  buildModelInput,
  getPremiumModel,
  pickPinnedModel,
  resolveImagePool
} from '@/lib/imagegen/registry'
import { nextRotationIndex } from '@/lib/imagegen/rotation'
import { trackRetry } from '@/lib/imagegen/retry-tracker'
```

In the top-level `beforeEach` add default behaviors (no pin, no escalation, pool = GENERATE_MODEL):

```ts
vi.mocked(pickPinnedModel).mockReturnValue(null)
vi.mocked(getPremiumModel).mockReturnValue({
  modelPath: 'google/nano-banana-pro'
} as any)
vi.mocked(trackRetry).mockResolvedValue({ attempt: 0, escalate: false })
vi.mocked(resolveImagePool).mockReturnValue({
  poolKey: 'generate:general',
  models: [GENERATE_MODEL]
})
vi.mocked(nextRotationIndex).mockResolvedValue(0)
```

Update every existing case that used `getImageModel`:

- Test 1 (happy path): drop `expect(getImageModel).toHaveBeenCalledWith('generate')`; the expected result becomes `{ imageUrl: '...', prompt: 'a red fox in snow' }` (NO modelId); add `expect(resolveImagePool).toHaveBeenCalledWith(expect.objectContaining({ role: 'generate' }))` and `expect(nextRotationIndex).toHaveBeenCalledWith('generate:general', 1)`.
- Test 2 (edit path): replace `vi.mocked(getImageModel).mockReturnValue(EDIT_MODEL)` with `vi.mocked(resolveImagePool).mockReturnValue({ poolKey: 'edit:general', models: [EDIT_MODEL] })`; replace the `res.modelId` assertion with `expect((res as any).modelId).toBeUndefined()`; keep the imageUrl assertion.
- Test 4 (https passthrough): same resolveImagePool substitution; drop the `getImageModel` assertion, assert `resolveImagePool` called with `expect.objectContaining({ role: 'edit' })`.
- Test 7 (billing): replace `getImageModel` setup with the beforeEach defaults (no change needed).

Add new cases at the end of the `createGenerateImageTool` describe:

```ts
// 8 ── selection precedence ────────────────────────────────────────────────
it('an env pin bypasses rotation entirely', async () => {
  allowBudget()
  vi.mocked(pickPinnedModel).mockReturnValue({
    modelPath: 'pinned/model'
  } as any)
  okPrediction()
  okPersist()

  await run({ prompt: 'a fox' })

  expect(resolveImagePool).not.toHaveBeenCalled()
  expect(nextRotationIndex).not.toHaveBeenCalled()
  expect(runReplicatePrediction).toHaveBeenCalledWith(
    expect.objectContaining({ modelPath: 'pinned/model' })
  )
})

it('quality premium uses the premium model and still records the attempt', async () => {
  allowBudget()
  okPrediction()
  okPersist()

  await run({ prompt: 'a fox', quality: 'premium' } as any)

  expect(trackRetry).toHaveBeenCalledWith('c1', false)
  expect(runReplicatePrediction).toHaveBeenCalledWith(
    expect.objectContaining({ modelPath: 'google/nano-banana-pro' })
  )
  expect(resolveImagePool).not.toHaveBeenCalled()
})

it('the 4th consecutive retry escalates to premium', async () => {
  allowBudget()
  vi.mocked(trackRetry).mockResolvedValue({ attempt: 4, escalate: true })
  okPrediction()
  okPersist()

  await run({ prompt: 'a fox', isRetry: true } as any)

  expect(trackRetry).toHaveBeenCalledWith('c1', true)
  expect(runReplicatePrediction).toHaveBeenCalledWith(
    expect.objectContaining({ modelPath: 'google/nano-banana-pro' })
  )
})

it('logo-svg requests never go premium, even on escalation or explicit quality', async () => {
  allowBudget()
  vi.mocked(trackRetry).mockResolvedValue({ attempt: 4, escalate: true })
  vi.mocked(resolveImagePool).mockReturnValue({
    poolKey: 'generate:logo-svg',
    models: [{ modelPath: 'recraft-ai/recraft-v4.1-svg' } as any]
  })
  okPrediction()
  okPersist()

  await run({ prompt: 'an svg logo', quality: 'premium', isRetry: true } as any)

  expect(runReplicatePrediction).toHaveBeenCalledWith(
    expect.objectContaining({ modelPath: 'recraft-ai/recraft-v4.1-svg' })
  )
})

it('rotation picks the model at the returned index', async () => {
  allowBudget()
  vi.mocked(resolveImagePool).mockReturnValue({
    poolKey: 'generate:general',
    models: [GENERATE_MODEL, { modelPath: 'second/model' } as any]
  })
  vi.mocked(nextRotationIndex).mockResolvedValue(1)
  okPrediction()
  okPersist()

  await run({ prompt: 'a fox' })

  expect(nextRotationIndex).toHaveBeenCalledWith('generate:general', 2)
  expect(runReplicatePrediction).toHaveBeenCalledWith(
    expect.objectContaining({ modelPath: 'second/model' })
  )
})

it('errors cleanly when the pool resolves empty', async () => {
  allowBudget()
  vi.mocked(resolveImagePool).mockReturnValue({
    poolKey: 'generate:general',
    models: []
  })

  const res = (await run({ prompt: 'a fox' })) as any

  expect(res.error).toMatch(/no image model/i)
  expect(runReplicatePrediction).not.toHaveBeenCalled()
})

it('falls back to a user-scoped retry key when there is no chatId', async () => {
  allowBudget()
  okPrediction()
  okPersist()

  await run({ prompt: 'a fox' }, 'u1', undefined)

  expect(trackRetry).toHaveBeenCalledWith('user:u1', false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test lib/tools/__tests__/generate-image.test.ts`
Expected: FAIL — tool still imports `getImageModel` (removed in Task 1), missing schema fields.

- [ ] **Step 3: Implement** — in `lib/tools/generate-image.ts`:

Replace the registry import line with:

```ts
import {
  buildModelInput,
  effectiveImageTask,
  getPremiumModel,
  IMAGE_TASKS,
  type ImageModelDef,
  pickPinnedModel,
  resolveImagePool
} from '@/lib/imagegen/registry'
import { nextRotationIndex } from '@/lib/imagegen/rotation'
import { trackRetry } from '@/lib/imagegen/retry-tracker'
```

Replace the tool `description` with:

```ts
    description:
      "Generate a new image from a text description, or edit/transform one of the user's uploaded images. Use this whenever the user asks to create, draw, make, design, or edit an image, picture, illustration, logo, or artwork. Write a vivid, specific, visual prompt. To edit an existing uploaded image, pass its exact URL from the attachment context as baseImageUrl. The image engine is selected automatically and rotates between requests — never state or guess which model produced an image. Declare `task` from the user's intent (photoreal photography, illustration, design/typography, logo-svg for vector work, draft-fast only when the user wants a quick rough result). If the user was unhappy with the previous image and wants another go, set isRetry: true; if they explicitly ask for top quality, set quality: 'premium'.",
```

Extend `inputSchema` with:

```ts
      task: z
        .enum(IMAGE_TASKS)
        .optional()
        .describe(
          'What kind of image the user wants; steers which engines are used.'
        ),
      quality: z
        .enum(['standard', 'premium'])
        .optional()
        .describe("Set 'premium' only when the user explicitly asks for top quality."),
      isRetry: z
        .boolean()
        .optional()
        .describe(
          'True when regenerating because the user was dissatisfied with the previous image in this chat.'
        )
```

Replace the `execute` signature and step 3 of its body (`// 3. Pick the model role...`) — the budget check and base-image resolution steps stay untouched:

```ts
execute: async ({
  prompt,
  baseImageUrl,
  aspectRatio,
  task,
  quality,
  isRetry
}) => {
  try {
    // 1. Budget — deny before any external call when the month is spent.
    //    (unchanged)
    // 2. Resolve the base image. (unchanged)

    // 3. Select the model: env pin → premium (explicit or 4th consecutive
    //    retry) → task pool round-robin. logo-svg never escalates to
    //    premium (no premium model emits SVG). The retry counter is
    //    tracked on every call so premium attempts count too.
    const role = baseImage ? ('edit' as const) : ('generate' as const)
    const effTask = effectiveImageTask(prompt, task)
    const retry = await trackRetry(chatId ?? `user:${userId}`, isRetry === true)

    let model: ImageModelDef | undefined
    let selection: string
    const pinned = pickPinnedModel(role)
    const premium = getPremiumModel(role)
    if (pinned) {
      model = pinned
      selection = 'pinned'
    } else if (
      (quality === 'premium' || retry.escalate) &&
      effTask !== 'logo-svg' &&
      premium
    ) {
      model = premium
      selection = 'premium'
    } else {
      const pool = resolveImagePool({ role, task, aspectRatio, prompt })
      if (pool.models.length === 0) {
        return { error: 'No image model available for this request.' }
      }
      const idx = await nextRotationIndex(pool.poolKey, pool.models.length)
      model = pool.models[idx]
      selection = pool.poolKey
    }
    const input = buildModelInput(model, { prompt, baseImage, aspectRatio })

    // 4. Run the prediction. (unchanged)
    // 5. Persist. (unchanged)
    // 6. Record spend. (unchanged)

    // 7. Ops trace — model identity is hidden from the user/LLM, so this
    //    log line is the only attribution for a given output file.
    console.log('[imagegen] generated', {
      chatId: chatId ?? null,
      objectKey: persisted.objectKey,
      model: model.modelPath,
      selection
    })

    // 8. Success — modelId deliberately absent (hidden identity).
    return {
      imageUrl: persisted.publicUrl,
      prompt,
      ...(aspectRatio ? { aspectRatio } : {})
    }
  } catch (e) {
    return {
      error: `Image generation failed: ${e instanceof Error ? e.message : 'unknown error'}`
    }
  }
}
```

(The commented "unchanged" steps are the existing code blocks — keep them exactly as they are, in the same order; only step 3's selection block, the log line, and the return payload change.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun run test lib/tools/__tests__/generate-image.test.ts && bun typecheck`
Expected: tests PASS; typecheck clean (this task restores whole-repo compilation).

- [ ] **Step 5: Commit**

```bash
git add lib/tools/generate-image.ts lib/tools/__tests__/generate-image.test.ts
git commit -m "Wire pin/premium/pool selection into generateImage and hide model identity"
```

---

### Task 9: SVG persistence + serving

**Files:**

- Modify: `lib/imagegen/persist-image.ts` (EXT_BY_CONTENT_TYPE), `lib/tools/generate-image.ts:26-32` (MEDIA_TYPE_BY_EXT), `app/uploads/[...path]/route.ts:57-67` (content-type ladder)
- Test: `lib/imagegen/__tests__/persist-image.test.ts`, `app/uploads/[...path]/__tests__/route.test.ts` (append one case each)

**Interfaces:** none new — extends existing maps so `recraft-v4.1-svg` outputs round-trip.

- [ ] **Step 1: Write the failing tests.**

In `lib/imagegen/__tests__/persist-image.test.ts`, add one row to the existing `it.each` content-type table (line ~164) so it reads:

```ts
  it.each([
    ['image/webp', 'webp'],
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/svg+xml', 'svg'],
    ['application/octet-stream', 'png'],
    [null, 'png']
  ])('maps content-type %s to extension .%s', async (contentType, ext) => {
```

(The each-body already asserts `res.objectKey.endsWith('.' + ext)` and the `generated-flux-1.1-pro.<ext>` filename — no body changes needed. `mediaType` passes through `normalizeContentType`, which is covered by the filename/extension assertions plus Task 9's map change.)

In `app/uploads/[...path]/__tests__/route.test.ts`, add an SVG fixture and case. After the `WEBP_BYTES` constant (line ~15):

```ts
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
  'utf8'
)
```

In `beforeAll`, after the `img.webp` write:

```ts
await writeFile(
  path.join(uploadsDir, 'u1', 'generated', 'c1', 'logo.svg'),
  SVG_BYTES
)
```

New case inside the describe:

```ts
it('serves an svg generation output as image/svg+xml', async () => {
  const res = await call(['u1', 'generated', 'c1', 'logo.svg'])

  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
  const body = Buffer.from(await res.arrayBuffer())
  expect(body.equals(SVG_BYTES)).toBe(true)
})
```

- [ ] **Step 2: Run to verify both fail** — `bun run test lib/imagegen/__tests__/persist-image.test.ts "app/uploads/[...path]/__tests__/route.test.ts"` → FAIL (png fallback / octet-stream).

- [ ] **Step 3: Implement the three map additions**:

`lib/imagegen/persist-image.ts` — add to `EXT_BY_CONTENT_TYPE`:

```ts
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg'
}
```

`lib/tools/generate-image.ts` — add to `MEDIA_TYPE_BY_EXT`:

```ts
  svg: 'image/svg+xml',
```

`app/uploads/[...path]/route.ts` — extend the ladder before the fallback:

```ts
            : ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.pdf'
                ? 'application/pdf'
                : 'application/octet-stream'
```

- [ ] **Step 4: Run to verify both pass.**

- [ ] **Step 5: Commit**

```bash
git add lib/imagegen/persist-image.ts lib/tools/generate-image.ts "app/uploads/[...path]/route.ts" lib/imagegen/__tests__/persist-image.test.ts "app/uploads/[...path]/__tests__/route.test.ts"
git commit -m "Round-trip SVG outputs through persist and the uploads route"
```

---

### Task 10: Hide model identity in the image card

**Files:**

- Modify: `components/generated-image-section.tsx`
- Test: `components/__tests__/generated-image-section.test.tsx`

**Interfaces:** consumes the Task 8 payload shape `{ imageUrl, prompt, aspectRatio? }`; legacy stored parts may still carry `modelId` — it must simply not render.

- [ ] **Step 1: Update the test** — in the success-path case, keep `modelId` in the fixture (legacy part) and change the caption assertions:

```ts
// Caption shows the prompt only — model identity is hidden, even for
// legacy parts that still carry a modelId.
expect(
  screen.getByText('a red fox in the snow', { selector: 'figcaption' })
).toBeInTheDocument()
expect(screen.queryByText(/black-forest-labs\/flux/)).not.toBeInTheDocument()
```

- [ ] **Step 2: Run to verify it fails** — `bun run test components/__tests__/generated-image-section.test.tsx` → FAIL (caption still contains the model).

- [ ] **Step 3: Implement** — in `components/generated-image-section.tsx`:

```ts
type GenerateImageOutput =
  | { imageUrl: string; prompt: string; aspectRatio?: string }
  | { error: string }
```

```tsx
<figcaption className="mt-1.5 text-xs text-muted-foreground truncate">
  {output.prompt}
</figcaption>
```

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add components/generated-image-section.tsx components/__tests__/generated-image-section.test.tsx
git commit -m "Drop model identity from the generated image caption"
```

---

### Task 11: Model-manager pin fields

**Files:**

- Modify: `selfhosted/model-manager/lib/env-schema.ts:313-354`

**Interfaces:** none — UI metadata only. The enumValues lists mirror the registry capability sets by hand (documented limitation at the NOTE comment).

- [ ] **Step 1: Update the two field definitions.** Replace the NOTE comment (lines 314–317) and the two entries:

```ts
  // NOTE: the model options below duplicate the capability arrays in the app's
  // lib/imagegen/models/*.json — model-manager cannot import from the app, so
  // these lists must be kept in sync by hand. Since the rotation feature
  // (2026-07-23) these vars are PIN OVERRIDES: unset = task-pool rotation;
  // set = that model handles every request for its role.
  {
    key: 'REPLICATE_IMAGE_MODEL',
    category: 'models',
    group: 'Image generation',
    label: 'Image generate model (pin)',
    type: 'enum',
    enumValues: [
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'google/imagen-4',
      'google/imagen-4-fast',
      'google/imagen-4-ultra',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image',
      'prunaai/z-image-turbo',
      'prunaai/z-image',
      'prunaai/ernie-image-turbo',
      'recraft-ai/recraft-v4.1',
      'recraft-ai/recraft-v4.1-pro',
      'recraft-ai/recraft-v4.1-utility',
      'recraft-ai/recraft-v4.1-svg',
      'bria/image-3.2',
      'bria/fibo'
    ],
    help: 'PIN override. Unset (recommended) = automatic task-pool rotation. Set = this model handles ALL text-to-image requests. nano-banana-pro is the intended premium pin.'
  },
  {
    key: 'REPLICATE_IMAGE_EDIT_MODEL',
    category: 'models',
    group: 'Image generation',
    label: 'Image edit model (pin)',
    type: 'enum',
    enumValues: [
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image-edit',
      'bria/fibo-edit'
    ],
    help: 'PIN override for edit requests (base image supplied). Unset (recommended) = rotation. Edit-capable models only.'
  },
```

Both entries deliberately LOSE their `default:` line — unset now means "rotate".

- [ ] **Step 2: Run model-manager checks**

Run: `cd selfhosted/model-manager && bunx vitest run lib/__tests__/env-schema.test.ts && cd ../..`
Expected: PASS. If an assertion pins the old enumValues or defaults, update that assertion to the new lists — the schema is the source of truth.

- [ ] **Step 3: Commit**

```bash
git add selfhosted/model-manager/lib/env-schema.ts
git commit -m "Model-manager: Replicate model fields become pin overrides with the full roster"
```

---

### Task 12: Full gates + staging deploy + E2E

**Files:** none new — verification only.

- [ ] **Step 1: Full local gates**

```bash
bun typecheck && bun lint && bun run format:check && bun run test
DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder bun run build
```

Expected: all pass. If format:check flags plan/spec docs, `bunx prettier --write <file>` them individually.

- [ ] **Step 2: Deploy to staging**

```bash
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d --build ask
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3739   # expect 200
```

- [ ] **Step 3: Staging E2E checklist** (paid Replicate calls on the `.env` token, operator-approved; keep to the minimum below):

1. Three plain generations in one chat → `docker logs ask-admin-feature | grep '\[imagegen\] generated'` shows three DIFFERENT `model:` values and `selection: 'generate:general'`; no model name appears in the chat UI or answer text.
2. One request wording "top quality / premium" → log shows `model: 'google/nano-banana-pro'`, `selection: 'premium'`.
3. One gpt-image-2 spin: repeat plain generations until the log shows `openai/gpt-image-2` (verifies no-OpenAI-key billing works). If it errors with an auth/billing class, REMOVE gpt-image-2 from MODELS (one-line registry change + roster count test 32→31) and note it in the build report.
4. One "svg logo of a paper plane" request → log shows `recraft-ai/recraft-v4.1-svg`; the image card renders the SVG in-browser.
5. One upload → edit request → log shows an edit-capable model and `selection: 'edit:general'`.

- [ ] **Step 4: Update the handoff + report.** Summarize results (including any roster removals from step 3) for the operator. Deploy to production only on explicit operator approval.

---

## Self-Review Notes

- Spec coverage: roster (Tasks 4–7), selection precedence + guardrails (Tasks 1, 8), rotation state (Task 2), retry escalation (Task 3), hidden identity payload/caption/description (Tasks 8, 10), ops log (Task 8), SVG round-trip (Task 9), config surface (Task 11), budget untouched (no task — spec says unchanged), staging E2E incl. gpt-image-2 and svg verification spins (Task 12).
- Deliberate deviations: none. `flux-fill-pro` and all mask/promptless utilities are Phase 2 per spec.
- Mid-plan compile gap: Tasks 1–7 leave `lib/tools/generate-image.ts` referencing a removed export; suites are run per-file until Task 8 restores `bun typecheck`. Task ordering is therefore NOT reorderable across the 1→8 boundary.
