# Model-manager UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Next.js app that manages Ask's entire `.env` from a structured web UI, writes it safely (atomic + backup + masked diff), and applies changes by restarting the affected containers locally (`ask`) and cross-host over SSH (`reranker` on nightfuryS).

**Architecture:** A separate Next.js 16 app at `selfhosted/model-manager/` with **zero code imports from Ask** — the only shared contract is the `.env` file format plus docker/ssh commands. A single typed **env-schema registry** drives a categorized form; a pure `.env` engine parses/edits/serializes while preserving comments, order, and unknown keys; a server-side apply orchestrator backs up, writes, and restarts; a fail-closed password gate protects everything.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts` middleware), React 19, TypeScript, Tailwind CSS, shadcn/ui (primitives copied from Ask), bun, vitest. Node `crypto`, `child_process` (`execFile`), `fs/promises`.

## Global Constraints

- Standalone app at `selfhosted/model-manager/`; **zero imports from Ask's source** (`@/…` of the parent app). Its only inputs are file paths and shell commands passed via its own env.
- Next.js 16 specifics: middleware file is **`proxy.ts`**, not `middleware.ts`. In files marked `'use server'`, **only `async function`s may be exported** — never a `const`/type. Put shared consts/types in plain (non-`'use server'`) modules.
- Test runner is **`bun run test`** (vitest), never `bun test`. Pre-commit gates for this app, run from `selfhosted/model-manager/`: `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build`, `bun run test` — all must pass.
- **Never** add a `Co-Authored-By: Claude` or any AI-attribution trailer to commits.
- **Fail-closed auth:** if `MODEL_MANAGER_PASSWORD` is unset the app refuses to serve (503), never opens up. Password checks use a constant-time compare.
- **Write safety:** every `.env` write is preceded by a timestamped backup and performed atomically (temp file + rename). Nothing is written or restarted until the user confirms a **secrets-masked** diff.
- **Secrets** are never logged and never rendered in plaintext in diffs or status. An unchanged secret field is left byte-for-byte untouched.
- **Do not push, redeploy, or touch production without approval.** This plan builds and tests locally only. Deploying the model-manager container and rolling the two enabling changes to prod/nightfuryS are separate, user-approved steps.
- LAN-bound only. This container holds root-equivalent power (rw `.env`, Docker socket, SSH key); the README must say so.

### The model-manager's own runtime config (its `.env`, with defaults)

| Var                            | Default                            | Meaning                               |
| ------------------------------ | ---------------------------------- | ------------------------------------- |
| `MODEL_MANAGER_PASSWORD`       | _(required)_                       | Gate password; unset ⇒ app serves 503 |
| `MODEL_MANAGER_SESSION_SECRET` | _(derived from password)_          | HMAC key for the session cookie       |
| `MODEL_MANAGER_PORT`           | `3939`                             | LAN port                              |
| `ASK_ENV_PATH`                 | `/ask/.env`                        | Path to Ask's `.env` (bind-mounted)   |
| `ASK_COMPOSE_FILE`             | `/ask/docker-compose.yaml`         | Ask compose file (bind-mounted)       |
| `ASK_SERVICE`                  | `ask`                              | Compose service name to recreate      |
| `MODEL_MANAGER_BACKUP_KEEP`    | `20`                               | How many `.env.bak.*` to retain       |
| `RERANKER_SSH_TARGET`          | _(unset ⇒ reranker mgmt disabled)_ | e.g. `user@192.168.50.160`            |
| `RERANKER_SSH_KEY`             | `/keys/nightfurys`                 | Mounted private key path              |
| `RERANKER_REMOTE_DIR`          | _(unset ⇒ reranker mgmt disabled)_ | Reranker compose dir on nightfuryS    |
| `RERANKER_ENV_FILE`            | `.env`                             | Reranker `.env` filename in that dir  |
| `RERANKER_SERVICE`             | `reranker`                         | Remote compose service name           |

If `RERANKER_SSH_TARGET`/`RERANKER_REMOTE_DIR` are unset, the reranker-model field is shown read-only with a "cross-host management not configured" note; all other function is unaffected.

---

## File Structure

**Enabling changes (Ask repo):**

- `lib/agents/query-classifier.ts` — env fallback for `CLASSIFIER_MODEL_ID`
- `lib/agents/query-expander.ts` — env fallback for `EXPANDER_MODEL_ID`
- `lib/agents/memory-extractor.ts` — env fallback for `MEMORY_EXTRACTOR_MODEL_ID`
- `selfhosted/reranker/docker-compose.yaml`, `selfhosted/reranker/.env.example` — `RERANKER_MODEL` moved to `.env`
- `components/settings-dialog.tsx` — remove `ModelsTab` (final, gated task)

**Model-manager app (`selfhosted/model-manager/`):**

- `package.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config.mjs`, `eslint.config.mjs`, `prettier.config.js`, `vitest.config.mts`, `vitest.setup.ts`, `.gitignore`, `Dockerfile`, `docker-compose.yaml`, `README.md`, `.env.example`
- `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/login/page.tsx`, `proxy.ts`
- `app/api/health/route.ts`, `app/api/login/route.ts`, `app/api/logout/route.ts`, `app/api/config/route.ts`, `app/api/preview/route.ts`, `app/api/apply/route.ts`, `app/api/backups/route.ts`, `app/api/restore/route.ts`, `app/api/test/route.ts`
- `lib/env-schema.ts` — registry + types (pure)
- `lib/env-file.ts` — parser/serializer (pure)
- `lib/model-list.ts` — comma-list codec (pure)
- `lib/diff.ts` — change computation + masked render (pure)
- `lib/backups.ts` — backup/list/prune/restore (fs + injected clock)
- `lib/exec.ts` — injectable command runner
- `lib/apply.ts` — apply orchestrator (uses runner)
- `lib/connection-tests.ts` — ollama/reranker probes (injectable fetch)
- `lib/auth.ts` — password gate + session cookie
- `lib/config.ts` — reads the tool's own runtime config (paths, ssh, etc.)
- `lib/utils.ts` — `cn()` (copied from Ask)
- `components/ui/*` — shadcn primitives copied from Ask
- `components/*` — form shell, field renderers, model-list editor, review/apply modal, backups panel

---

## Task 1: Ask — env-driven serenity model names

**Files:**

- Modify: `lib/agents/query-classifier.ts` (the `CLASSIFIER_MODEL_ID` constant)
- Modify: `lib/agents/query-expander.ts` (the `EXPANDER_MODEL_ID` constant)
- Modify: `lib/agents/memory-extractor.ts:8` (the `MODEL_ID` constant)
- Test: `lib/agents/__tests__/model-id-env.test.ts`

**Interfaces:**

- Produces: env vars `CLASSIFIER_MODEL_ID`, `EXPANDER_MODEL_ID`, `MEMORY_EXTRACTOR_MODEL_ID` (all default `granite4.1:8b`), consumed by Ask and set by the model-manager registry (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// lib/agents/__tests__/model-id-env.test.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// These constants gate which model runs on serenity. They must read from env
// (so the model-manager UI can change them) while defaulting to the current
// value (so behavior is unchanged until edited).
const cases: [string, string][] = [
  ['lib/agents/query-classifier.ts', 'CLASSIFIER_MODEL_ID'],
  ['lib/agents/query-expander.ts', 'EXPANDER_MODEL_ID'],
  ['lib/agents/memory-extractor.ts', 'MEMORY_EXTRACTOR_MODEL_ID']
]

describe('serenity model ids are env-driven', () => {
  for (const [file, envVar] of cases) {
    it(`${file} reads ${envVar} from env with granite default`, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      expect(src).toContain(`process.env.${envVar}`)
      expect(src).toContain(`'granite4.1:8b'`)
    })
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/agents/__tests__/model-id-env.test.ts`
Expected: FAIL — the source files don't yet reference the env vars.

- [ ] **Step 3: Apply the env fallback in all three files**

In `lib/agents/query-classifier.ts`, change the hardcoded constant to:

```ts
const CLASSIFIER_MODEL_ID = process.env.CLASSIFIER_MODEL_ID ?? 'granite4.1:8b'
```

In `lib/agents/query-expander.ts`:

```ts
const EXPANDER_MODEL_ID = process.env.EXPANDER_MODEL_ID ?? 'granite4.1:8b'
```

In `lib/agents/memory-extractor.ts:8` (constant is named `MODEL_ID`):

```ts
const MODEL_ID = process.env.MEMORY_EXTRACTOR_MODEL_ID ?? 'granite4.1:8b'
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test lib/agents/__tests__/model-id-env.test.ts && bun typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/query-classifier.ts lib/agents/query-expander.ts lib/agents/memory-extractor.ts lib/agents/__tests__/model-id-env.test.ts
git commit -m "feat(agents): make serenity model ids env-driven (default granite4.1:8b)"
```

---

## Task 2: Reranker — move RERANKER_MODEL into its .env

**Files:**

- Modify: `selfhosted/reranker/docker-compose.yaml` (drop the `environment: RERANKER_MODEL` line)
- Modify: `selfhosted/reranker/.env.example` (add `RERANKER_MODEL`)
- Test: `selfhosted/reranker/__tests__/reranker-config.test.ts`

**Interfaces:**

- Produces: `RERANKER_MODEL` now lives in the reranker's `.env` (default `BAAI/bge-reranker-v2-m3`). `app.py` already reads `os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")`, so no Python change is needed. The model-manager writes this file over SSH (Task 10).

- [ ] **Step 1: Write the failing test**

```ts
// selfhosted/reranker/__tests__/reranker-config.test.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const dir = join(process.cwd(), 'selfhosted/reranker')

describe('reranker model is env-file driven', () => {
  it('compose no longer hardcodes RERANKER_MODEL in environment', () => {
    const compose = readFileSync(join(dir, 'docker-compose.yaml'), 'utf8')
    expect(compose).not.toMatch(/^\s*RERANKER_MODEL:/m)
  })
  it('.env.example documents RERANKER_MODEL with the current default', () => {
    const env = readFileSync(join(dir, '.env.example'), 'utf8')
    expect(env).toMatch(/^RERANKER_MODEL=BAAI\/bge-reranker-v2-m3$/m)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test selfhosted/reranker/__tests__/reranker-config.test.ts`
Expected: FAIL — compose still sets `RERANKER_MODEL:` and `.env.example` lacks it.

- [ ] **Step 3: Edit the two config files**

In `selfhosted/reranker/docker-compose.yaml`, delete the `RERANKER_MODEL: BAAI/bge-reranker-v2-m3` line under `environment:`. (The service already has `env_file: .env`; leave that.) If `environment:` becomes empty, remove the empty key.

In `selfhosted/reranker/.env.example`, add below the existing token line:

```bash
# Cross-encoder model served by the reranker. Changing this re-downloads
# weights on next start (slow). Managed by the model-manager UI over SSH.
RERANKER_MODEL=BAAI/bge-reranker-v2-m3
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test selfhosted/reranker/__tests__/reranker-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/reranker/docker-compose.yaml selfhosted/reranker/.env.example selfhosted/reranker/__tests__/reranker-config.test.ts
git commit -m "refactor(reranker): move RERANKER_MODEL from compose into .env"
```

> **Deploy note (not part of this commit):** applying this on nightfuryS requires adding `RERANKER_MODEL=BAAI/bge-reranker-v2-m3` to that box's live reranker `.env` before the next `docker compose up -d reranker`, so the model is unchanged. This is a user-approved deploy step.

---

## Task 3: Scaffold the model-manager app

**Files (all under `selfhosted/model-manager/`):**

- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config.mjs`, `prettier.config.js`, `eslint.config.mjs`, `vitest.config.mts`, `vitest.setup.ts`, `.gitignore`
- Create: `app/layout.tsx`, `app/globals.css`, `app/api/health/route.ts`
- Create: `lib/utils.ts`
- Test: `app/api/health/__tests__/health.test.ts`

**Interfaces:**

- Produces: a runnable Next.js app; `cn()` from `lib/utils.ts`; the `bun run` gate scripts. All later tasks build on this.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "model-manager",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3939",
    "build": "next build",
    "start": "next start -p 3939",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "NODE_ENV=test vitest run",
    "test:watch": "vitest --watch"
  },
  "dependencies": {
    "next": "16.2.1",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.4",
    "lucide-react": "^0.469.0",
    "sonner": "^1.7.1",
    "@radix-ui/react-switch": "^1.1.2",
    "@radix-ui/react-select": "^2.1.4",
    "@radix-ui/react-dialog": "^1.1.4",
    "@radix-ui/react-label": "^2.1.1",
    "@radix-ui/react-tabs": "^1.1.2",
    "@radix-ui/react-alert-dialog": "^1.1.4"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "@types/node": "^22.10.2",
    "@types/react": "19.2.0",
    "@types/react-dom": "19.2.0",
    "tailwindcss": "^3.4.17",
    "postcss": "^8.4.49",
    "autoprefixer": "^10.4.20",
    "eslint": "^9",
    "eslint-config-next": "16.2.1",
    "prettier": "^3.4.2",
    "vitest": "^2.1.8",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "jsdom": "^25.0.1"
  }
}
```

- [ ] **Step 2: Create the config files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = { output: 'standalone' }
export default nextConfig
```

`postcss.config.mjs`:

```js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
```

`prettier.config.js`:

```js
module.exports = { semi: false, singleQuote: true, trailingComma: 'none' }
```

`eslint.config.mjs`:

```js
import next from 'eslint-config-next'
export default [...next()]
```

`tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss'
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: []
} satisfies Config
```

`vitest.config.mts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./', import.meta.url)) } }
})
```

(Add `@vitejs/plugin-react` to devDependencies.)

`vitest.setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

`.gitignore`:

```
node_modules
.next
.env
.env.local
*.bak.*
```

- [ ] **Step 3: Create `lib/utils.ts`, `app/globals.css`, `app/layout.tsx`**

`lib/utils.ts` (copy Ask's):

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

`app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

`app/layout.tsx`:

```tsx
import './globals.css'
import { Toaster } from 'sonner'

export const metadata = { title: 'Ask Model Manager' }

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
```

- [ ] **Step 4: Create the health route + its test**

`app/api/health/route.ts`:

```ts
export function GET() {
  return Response.json({ ok: true })
}
```

`app/api/health/__tests__/health.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GET } from '../route'

describe('health route', () => {
  it('returns ok', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
```

- [ ] **Step 5: Install, run gates**

Run:

```bash
cd selfhosted/model-manager && bun install && bun run test && bun run typecheck && bun run build
```

Expected: install succeeds; test PASSES; typecheck clean; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add selfhosted/model-manager
git commit -m "chore(model-manager): scaffold standalone Next.js app"
```

---

## Task 4: The tool's own runtime config reader

**Files:**

- Create: `selfhosted/model-manager/lib/config.ts`
- Test: `selfhosted/model-manager/lib/__tests__/config.test.ts`

**Interfaces:**

- Produces: `getToolConfig(env?): ToolConfig` returning `{ askEnvPath, askComposeFile, askService, backupKeep, reranker: RerankerConfig | null }` where `RerankerConfig = { sshTarget, sshKey, remoteDir, envFile, service }`. `reranker` is `null` when `RERANKER_SSH_TARGET` or `RERANKER_REMOTE_DIR` is unset.

- [ ] **Step 1: Write the failing test**

```ts
// lib/__tests__/config.test.ts
import { describe, expect, it } from 'vitest'
import { getToolConfig } from '../config'

describe('getToolConfig', () => {
  it('applies defaults', () => {
    const c = getToolConfig({})
    expect(c.askEnvPath).toBe('/ask/.env')
    expect(c.askService).toBe('ask')
    expect(c.backupKeep).toBe(20)
    expect(c.reranker).toBeNull()
  })
  it('builds reranker config when ssh vars present', () => {
    const c = getToolConfig({
      RERANKER_SSH_TARGET: 'u@h',
      RERANKER_REMOTE_DIR: '/srv/reranker'
    })
    expect(c.reranker).toEqual({
      sshTarget: 'u@h',
      sshKey: '/keys/nightfurys',
      remoteDir: '/srv/reranker',
      envFile: '.env',
      service: 'reranker'
    })
  })
  it('parses backupKeep as int', () => {
    expect(getToolConfig({ MODEL_MANAGER_BACKUP_KEEP: '5' }).backupKeep).toBe(5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/config.ts`**

```ts
export interface RerankerConfig {
  sshTarget: string
  sshKey: string
  remoteDir: string
  envFile: string
  service: string
}

export interface ToolConfig {
  askEnvPath: string
  askComposeFile: string
  askService: string
  backupKeep: number
  reranker: RerankerConfig | null
}

export function getToolConfig(
  env: NodeJS.ProcessEnv = process.env
): ToolConfig {
  const sshTarget = env.RERANKER_SSH_TARGET
  const remoteDir = env.RERANKER_REMOTE_DIR
  const reranker =
    sshTarget && remoteDir
      ? {
          sshTarget,
          sshKey: env.RERANKER_SSH_KEY || '/keys/nightfurys',
          remoteDir,
          envFile: env.RERANKER_ENV_FILE || '.env',
          service: env.RERANKER_SERVICE || 'reranker'
        }
      : null

  return {
    askEnvPath: env.ASK_ENV_PATH || '/ask/.env',
    askComposeFile: env.ASK_COMPOSE_FILE || '/ask/docker-compose.yaml',
    askService: env.ASK_SERVICE || 'ask',
    backupKeep: Number.parseInt(env.MODEL_MANAGER_BACKUP_KEEP || '20', 10),
    reranker
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/config.ts selfhosted/model-manager/lib/__tests__/config.test.ts
git commit -m "feat(model-manager): runtime config reader with defaults"
```

---

## Task 5: Env-schema registry + types

**Files:**

- Create: `selfhosted/model-manager/lib/env-schema.ts`
- Test: `selfhosted/model-manager/lib/__tests__/env-schema.test.ts`
- Test data: `selfhosted/model-manager/lib/__tests__/fixtures/ask.env.sample`

**Interfaces:**

- Produces: `EnvVarSpec` (type), `REGISTRY: EnvVarSpec[]`, `CATEGORIES` (ordered list), `specByKey(key): EnvVarSpec | undefined`, `validators` used by the UI. Consumed by diff (Task 7), config route (Task 13), and the form (Task 15).

- [ ] **Step 1: Write the failing tests (registry integrity + .env parity)**

Create the fixture `lib/__tests__/fixtures/ask.env.sample` containing the **keys** of the real Ask `.env` (values dummied), e.g.:

```bash
OLLAMA_BASE_URL=http://x:11434
OLLAMA_MODELS=a:cloud, b:cloud
CLASSIFIER_OLLAMA_BASE_URL=http://x:11434
EMBEDDING_MODEL=mixedbread-ai/mxbai-embed-large-v1
RERANKER_URL=http://x:8787
RERANKER_API_TOKEN=x
SEARCH_API=searxng
SEARXNG_API_URL=http://x
DATABASE_URL=postgres://x
POSTGRES_USER=morphic
ENABLE_AUTH=true
MEMORY_ENABLED=true
RECALL_ENABLED=true
HOST_PORT=3738
# ...copy every KEY= line present in the real /home/nightfury/selfhosted/ask/.env
```

```ts
// lib/__tests__/env-schema.test.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { CATEGORIES, REGISTRY, specByKey } from '../env-schema'

const IGNORE = new Set<string>([
  // keys deliberately NOT managed by the UI (add here with justification)
])

describe('registry integrity', () => {
  it('has unique keys', () => {
    const keys = REGISTRY.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('every spec has a known category', () => {
    for (const s of REGISTRY) expect(CATEGORIES).toContain(s.category)
  })
  it('enum specs list their allowed values', () => {
    for (const s of REGISTRY.filter(s => s.type === 'enum')) {
      expect(s.enumValues && s.enumValues.length).toBeTruthy()
    }
  })
  it('validators return null for good input and a string for bad', () => {
    const url = specByKey('OLLAMA_BASE_URL')!
    expect(url.validate!('http://192.168.50.231:11434')).toBeNull()
    expect(typeof url.validate!('not-a-url')).toBe('string')
  })
})

describe('.env parity — every key in Ask .env has a spec', () => {
  it('covers all keys', () => {
    const sample = readFileSync(
      join(__dirname, 'fixtures/ask.env.sample'),
      'utf8'
    )
    const keys = sample
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.split('=')[0])
    const missing = keys.filter(k => !specByKey(k) && !IGNORE.has(k))
    expect(missing, `unmanaged keys: ${missing.join(', ')}`).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/env-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/env-schema.ts`**

Define the type and helpers, then the registry. Fill the registry so the parity test passes for the real `.env`; the entries below cover the model/service planes fully — **add the remaining keys from the fixture following the same shape until parity passes** (the test is the completeness gate).

```ts
export type Category =
  | 'models'
  | 'search'
  | 'database'
  | 'auth'
  | 'memory'
  | 'storage'
  | 'infra'

export const CATEGORIES: Category[] = [
  'models',
  'search',
  'database',
  'auth',
  'memory',
  'storage',
  'infra'
]

export type FieldType =
  | 'url'
  | 'model'
  | 'model-list'
  | 'secret'
  | 'bool'
  | 'int'
  | 'enum'
  | 'string'

export interface EnvVarSpec {
  key: string
  category: Category
  group?: string
  label: string
  type: FieldType
  help?: string
  default?: string
  required?: boolean
  enumValues?: string[]
  validate?: (v: string) => string | null
  target?: 'ask' | 'reranker' // default 'ask'
  testable?: 'ollama' | 'reranker' | 'http'
}

// --- shared validators ---
const url = (v: string): string | null =>
  /^https?:\/\/.+/.test(v.trim()) ? null : 'Must be an http(s) URL'
const int = (v: string): string | null =>
  /^-?\d+$/.test(v.trim()) ? null : 'Must be an integer'
const num = (v: string): string | null =>
  /^-?\d+(\.\d+)?$/.test(v.trim()) ? null : 'Must be a number'
const bool = (v: string): string | null =>
  /^(true|false)$/.test(v.trim()) ? null : 'Must be true or false'
const nonEmpty = (v: string): string | null =>
  v.trim().length ? null : 'Required'

export const REGISTRY: EnvVarSpec[] = [
  // ---------- Models: Chat ----------
  {
    key: 'OLLAMA_BASE_URL',
    category: 'models',
    group: 'Chat',
    label: 'Chat host',
    type: 'url',
    validate: url,
    testable: 'ollama',
    help: 'Main Ollama LLM host.'
  },
  {
    key: 'NEXT_PUBLIC_OLLAMA_BASE_URL',
    category: 'models',
    group: 'Chat',
    label: 'Chat host (client)',
    type: 'url',
    validate: url,
    help: 'Client-exposed copy; usually mirrors OLLAMA_BASE_URL.'
  },
  {
    key: 'OLLAMA_MODELS',
    category: 'models',
    group: 'Chat',
    label: 'Chat model list',
    type: 'model-list',
    help: 'Cloud models not shown by /api/tags. Add / remove / reorder.'
  },
  {
    key: 'OLLAMA_EMBED_MODEL',
    category: 'models',
    group: 'Chat',
    label: 'Ollama embed model',
    type: 'model',
    help: 'Optional Ollama-side embedding model.'
  },
  // ---------- Models: Cloud providers ----------
  {
    key: 'OPENAI_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI API key',
    type: 'secret'
  },
  {
    key: 'ANTHROPIC_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'Anthropic API key',
    type: 'secret'
  },
  {
    key: 'GOOGLE_GENERATIVE_AI_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'Google GenAI API key',
    type: 'secret'
  },
  {
    key: 'AI_GATEWAY_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'AI Gateway key',
    type: 'secret'
  },
  {
    key: 'OPENAI_COMPATIBLE_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible key',
    type: 'secret'
  },
  {
    key: 'OPENAI_COMPATIBLE_API_BASE_URL',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible base URL',
    type: 'url',
    validate: url
  },
  {
    key: 'OPENAI_COMPATIBLE_PROVIDER_NAME',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible label',
    type: 'string'
  },
  {
    key: 'OPENAI_COMPATIBLE_MODELS',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible models',
    type: 'model-list'
  },
  // ---------- Models: Serenity ----------
  {
    key: 'CLASSIFIER_OLLAMA_BASE_URL',
    category: 'models',
    group: 'Serenity',
    label: 'Serenity host',
    type: 'url',
    validate: url,
    testable: 'ollama',
    help: 'Classifier/expander/extractor Ollama host (falls back to Chat host).'
  },
  {
    key: 'CLASSIFIER_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Classifier model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  {
    key: 'EXPANDER_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Query-expander model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  {
    key: 'MEMORY_EXTRACTOR_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Memory-extractor model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  // ---------- Models: Embeddings ----------
  {
    key: 'EMBEDDING_MODEL',
    category: 'models',
    group: 'Embeddings',
    label: 'Embedding model',
    type: 'enum',
    enumValues: [
      'Xenova/all-MiniLM-L6-v2',
      'mixedbread-ai/mxbai-embed-large-v1',
      'Xenova/nomic-embed-text-v1'
    ],
    help: 'Local ONNX embeddings. Changing dimension affects the memory/recall schema.'
  },
  {
    key: 'MODEL_CACHE_DIR',
    category: 'models',
    group: 'Embeddings',
    label: 'Model cache dir',
    type: 'string'
  },
  // ---------- Models: Reranker ----------
  {
    key: 'RERANKER_URL',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker URL (Ask → reranker)',
    type: 'url',
    validate: url,
    testable: 'reranker',
    target: 'ask'
  },
  {
    key: 'RERANKER_API_TOKEN',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker API token',
    type: 'secret',
    target: 'ask'
  },
  {
    key: 'RERANKER_MODEL',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker model (on nightfuryS)',
    type: 'model',
    default: 'BAAI/bge-reranker-v2-m3',
    target: 'reranker',
    help: 'Applied over SSH; a change re-downloads weights (slow).'
  },

  // ---------- Search ----------
  {
    key: 'SEARCH_API',
    category: 'search',
    label: 'Search backend',
    type: 'enum',
    enumValues: ['searxng', 'tavily', 'exa', 'brave']
  },
  {
    key: 'SEARXNG_API_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG URL',
    type: 'url',
    validate: url
  },
  {
    key: 'SEARXNG_FALLBACK_API_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG fallback URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_SEARXNG_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG URL (client)',
    type: 'url',
    validate: url
  },
  {
    key: 'SEARXNG_SECRET',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG secret',
    type: 'secret'
  },
  {
    key: 'SEARXNG_ENGINES',
    category: 'search',
    group: 'SearXNG',
    label: 'Engines',
    type: 'string'
  },
  {
    key: 'SEARXNG_MAX_RESULTS',
    category: 'search',
    group: 'SearXNG',
    label: 'Max results',
    type: 'int',
    validate: int
  },
  {
    key: 'SEARXNG_DEFAULT_DEPTH',
    category: 'search',
    group: 'SearXNG',
    label: 'Default depth',
    type: 'string'
  },
  {
    key: 'SEARXNG_TIME_RANGE',
    category: 'search',
    group: 'SearXNG',
    label: 'Time range',
    type: 'string'
  },
  {
    key: 'SEARXNG_SAFESEARCH',
    category: 'search',
    group: 'SearXNG',
    label: 'Safesearch',
    type: 'int',
    validate: int
  },
  {
    key: 'SEARXNG_CRAWL_MULTIPLIER',
    category: 'search',
    group: 'SearXNG',
    label: 'Crawl multiplier',
    type: 'int',
    validate: int
  },
  {
    key: 'CRAWL4AI_URL',
    category: 'search',
    group: 'Crawl',
    label: 'Crawl4AI URL',
    type: 'url',
    validate: url
  },
  {
    key: 'CRAWL4AI_API_TOKEN',
    category: 'search',
    group: 'Crawl',
    label: 'Crawl4AI token',
    type: 'secret'
  },
  {
    key: 'FLARESOLVERR_URL',
    category: 'search',
    group: 'Crawl',
    label: 'FlareSolverr URL',
    type: 'url',
    validate: url
  },
  {
    key: 'FIRECRAWL_API_KEY',
    category: 'search',
    group: 'Crawl',
    label: 'Firecrawl key',
    type: 'secret'
  },
  {
    key: 'DEGOOG_API_URL',
    category: 'search',
    group: 'Degoog',
    label: 'Degoog URL',
    type: 'url',
    validate: url
  },
  {
    key: 'DEGOOG_API_KEY',
    category: 'search',
    group: 'Degoog',
    label: 'Degoog key',
    type: 'secret'
  },
  {
    key: 'TAVILY_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Tavily key',
    type: 'secret'
  },
  {
    key: 'EXA_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Exa key',
    type: 'secret'
  },
  {
    key: 'BRAVE_SEARCH_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Brave key',
    type: 'secret'
  },
  {
    key: 'JINA_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Jina key',
    type: 'secret'
  },
  {
    key: 'OLLAMA_SEARCH_API_KEY',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search key',
    type: 'secret'
  },
  {
    key: 'OLLAMA_SEARCH_ENABLED',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'OLLAMA_SEARCH_MAX_RESULTS',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search max results',
    type: 'int',
    validate: int
  },
  {
    key: 'OLLAMA_SEARCH_TIMEOUT_MS',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search timeout (ms)',
    type: 'int',
    validate: int
  },

  // ---------- Database ----------
  {
    key: 'DATABASE_URL',
    category: 'database',
    label: 'Database URL',
    type: 'secret',
    validate: nonEmpty
  },
  {
    key: 'DATABASE_RESTRICTED_URL',
    category: 'database',
    label: 'Restricted DB URL',
    type: 'secret'
  },
  {
    key: 'DATABASE_SSL_DISABLED',
    category: 'database',
    label: 'Disable DB SSL',
    type: 'bool',
    validate: bool
  },
  {
    key: 'POSTGRES_USER',
    category: 'database',
    label: 'Postgres user',
    type: 'string'
  },
  {
    key: 'POSTGRES_PASSWORD',
    category: 'database',
    label: 'Postgres password',
    type: 'secret'
  },
  {
    key: 'POSTGRES_DB',
    category: 'database',
    label: 'Postgres db',
    type: 'string'
  },

  // ---------- Auth ----------
  {
    key: 'ENABLE_AUTH',
    category: 'auth',
    label: 'Enable auth',
    type: 'bool',
    validate: bool
  },
  {
    key: 'ANONYMOUS_USER_ID',
    category: 'auth',
    label: 'Anonymous user id',
    type: 'string'
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_URL',
    category: 'auth',
    label: 'Supabase URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    category: 'auth',
    label: 'Supabase publishable key',
    type: 'string'
  },
  {
    key: 'SUPABASE_SECRET_KEY',
    category: 'auth',
    label: 'Supabase secret key',
    type: 'secret'
  },

  // ---------- Memory / recall ----------
  {
    key: 'MEMORY_ENABLED',
    category: 'memory',
    label: 'Memory enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'MEMORY_SIM_THRESHOLD',
    category: 'memory',
    label: 'Memory sim threshold',
    type: 'string',
    validate: num
  },
  {
    key: 'MEMORY_GRADUATE_SIGHTINGS',
    category: 'memory',
    label: 'Graduate sightings',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_MAX_PER_USER',
    category: 'memory',
    label: 'Max per user',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_INJECT_TOP_K',
    category: 'memory',
    label: 'Inject top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_CRON_SECRET',
    category: 'memory',
    label: 'Memory cron secret',
    type: 'secret'
  },
  {
    key: 'RECALL_ENABLED',
    category: 'memory',
    label: 'Recall enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'RECALL_INJECT_TOP_K',
    category: 'memory',
    label: 'Recall inject top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_INJECT_MIN_SCORE',
    category: 'memory',
    label: 'Recall inject min score',
    type: 'string',
    validate: num
  },
  {
    key: 'RECALL_SEARCH_MIN_SCORE',
    category: 'memory',
    label: 'Recall search min score',
    type: 'string',
    validate: num
  },
  {
    key: 'RECALL_TOOL_TOP_K',
    category: 'memory',
    label: 'Recall tool top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_CHUNK_TOKENS',
    category: 'memory',
    label: 'Recall chunk tokens',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_CHUNK_OVERLAP',
    category: 'memory',
    label: 'Recall chunk overlap',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_RERANK_POOL',
    category: 'memory',
    label: 'Recall rerank pool',
    type: 'int',
    validate: int
  },

  // ---------- Infra ----------
  {
    key: 'HOST_PORT',
    category: 'infra',
    label: 'Ask host port',
    type: 'int',
    validate: int
  },
  {
    key: 'BASE_URL',
    category: 'infra',
    label: 'Base URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_BASE_URL',
    category: 'infra',
    label: 'Base URL (client)',
    type: 'url',
    validate: url
  },
  {
    key: 'LOCAL_REDIS_URL',
    category: 'infra',
    label: 'Local Redis URL',
    type: 'string'
  },
  {
    key: 'UPSTASH_REDIS_REST_URL',
    category: 'infra',
    label: 'Upstash Redis URL',
    type: 'url',
    validate: url
  },
  {
    key: 'UPSTASH_REDIS_REST_TOKEN',
    category: 'infra',
    label: 'Upstash Redis token',
    type: 'secret'
  },
  {
    key: 'MORPHIC_CLOUD_DEPLOYMENT',
    category: 'infra',
    label: 'Cloud deployment',
    type: 'bool',
    validate: bool
  }

  // NOTE: run the parity test; for any remaining key in the real .env
  // (e.g. R2/S3 storage vars → category 'storage', PostHog/Langfuse →
  // 'infra'), add an entry here of the correct type until the test passes.
]

const byKey = new Map(REGISTRY.map(s => [s.key, s]))
export function specByKey(key: string): EnvVarSpec | undefined {
  return byKey.get(key)
}
```

- [ ] **Step 4: Complete the registry until parity passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/env-schema.test.ts`
If the parity test lists unmanaged keys, add a spec for each (correct `category`/`type`/`label`; secrets → `type: 'secret'`) and re-run until PASS. Storage (R2/S3) keys use `category: 'storage'`.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/env-schema.ts selfhosted/model-manager/lib/__tests__/env-schema.test.ts selfhosted/model-manager/lib/__tests__/fixtures/ask.env.sample
git commit -m "feat(model-manager): env-schema registry covering every .env var"
```

---

## Task 6: `.env` parser / serializer

**Files:**

- Create: `selfhosted/model-manager/lib/env-file.ts`
- Test: `selfhosted/model-manager/lib/__tests__/env-file.test.ts`

**Interfaces:**

- Produces:
  - `parseEnv(text: string): EnvDoc`
  - `serializeEnv(doc: EnvDoc): string`
  - `getValue(doc: EnvDoc, key: string): string | undefined`
  - `setValue(doc: EnvDoc, key: string, value: string): EnvDoc` (immutable)
  - `toValueMap(doc: EnvDoc): Record<string, string>`
  - type `EnvDoc = { lines: EnvLine[] }`
- Consumed by: diff (Task 7), config/apply routes (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/env-file.test.ts
import { describe, expect, it } from 'vitest'
import {
  getValue,
  parseEnv,
  serializeEnv,
  setValue,
  toValueMap
} from '../env-file'

const SAMPLE = `# comment
OLLAMA_BASE_URL=http://192.168.50.231:11434

OLLAMA_MODELS=a:cloud, b:cloud
QUOTED="has space"
UNKNOWN_KEEP=1
`

describe('env-file', () => {
  it('round-trips unedited content byte-for-byte', () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE)
  })
  it('reads values, unquoting', () => {
    const d = parseEnv(SAMPLE)
    expect(getValue(d, 'OLLAMA_BASE_URL')).toBe('http://192.168.50.231:11434')
    expect(getValue(d, 'QUOTED')).toBe('has space')
    expect(getValue(d, 'MISSING')).toBeUndefined()
  })
  it('edits in place, preserving surrounding lines', () => {
    const d = setValue(parseEnv(SAMPLE), 'OLLAMA_BASE_URL', 'http://new:11434')
    const out = serializeEnv(d)
    expect(out).toContain('OLLAMA_BASE_URL=http://new:11434')
    expect(out).toContain('# comment')
    expect(out).toContain('UNKNOWN_KEEP=1')
  })
  it('quotes values that need it', () => {
    const d = setValue(parseEnv(SAMPLE), 'OLLAMA_BASE_URL', 'a b')
    expect(serializeEnv(d)).toContain('OLLAMA_BASE_URL="a b"')
  })
  it('appends a missing key', () => {
    const out = serializeEnv(setValue(parseEnv(SAMPLE), 'NEW_KEY', 'v'))
    expect(out).toContain('NEW_KEY=v')
  })
  it('builds a value map of all pairs', () => {
    const m = toValueMap(parseEnv(SAMPLE))
    expect(m.OLLAMA_MODELS).toBe('a:cloud, b:cloud')
    expect(m.UNKNOWN_KEEP).toBe('1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/env-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/env-file.ts`**

```ts
export type EnvLine =
  | { kind: 'pair'; key: string; value: string; raw: string }
  | { kind: 'other'; raw: string }

export interface EnvDoc {
  lines: EnvLine[]
  trailingNewline: boolean
}

const PAIR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function unquote(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
    return t.slice(1, -1)
  }
  return t
}

function formatValue(v: string): string {
  if (v === '' || /[\s"'#=]/.test(v)) {
    return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  return v
}

export function parseEnv(text: string): EnvDoc {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const rawLines = body.length === 0 && !trailingNewline ? [] : body.split('\n')
  const lines: EnvLine[] = rawLines.map(raw => {
    const m = raw.match(PAIR)
    if (m) return { kind: 'pair', key: m[1], value: unquote(m[2]), raw }
    return { kind: 'other', raw }
  })
  return { lines, trailingNewline }
}

export function serializeEnv(doc: EnvDoc): string {
  const body = doc.lines.map(l => l.raw).join('\n')
  return doc.trailingNewline ? body + '\n' : body
}

export function getValue(doc: EnvDoc, key: string): string | undefined {
  for (const l of doc.lines)
    if (l.kind === 'pair' && l.key === key) return l.value
  return undefined
}

export function toValueMap(doc: EnvDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of doc.lines) if (l.kind === 'pair') out[l.key] = l.value
  return out
}

export function setValue(doc: EnvDoc, key: string, value: string): EnvDoc {
  const raw = `${key}=${formatValue(value)}`
  let found = false
  const lines = doc.lines.map(l => {
    if (l.kind === 'pair' && l.key === key) {
      found = true
      return { kind: 'pair', key, value, raw } as EnvLine
    }
    return l
  })
  if (!found) lines.push({ kind: 'pair', key, value, raw })
  return { lines, trailingNewline: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/env-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/env-file.ts selfhosted/model-manager/lib/__tests__/env-file.test.ts
git commit -m "feat(model-manager): lossless .env parser/serializer"
```

---

## Task 7: Model-list codec

**Files:**

- Create: `selfhosted/model-manager/lib/model-list.ts`
- Test: `selfhosted/model-manager/lib/__tests__/model-list.test.ts`

**Interfaces:**

- Produces: `parseList(v: string): string[]`, `serializeList(items: string[]): string`, `addItem(items, item): string[]`, `removeAt(items, i): string[]`, `move(items, from, to): string[]`. Consumed by the model-list editor (Task 16).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/model-list.test.ts
import { describe, expect, it } from 'vitest'
import {
  addItem,
  move,
  parseList,
  removeAt,
  serializeList
} from '../model-list'

describe('model-list codec', () => {
  it('parses comma lists, trimming and dropping empties', () => {
    expect(parseList('a:cloud,  b:cloud , ')).toEqual(['a:cloud', 'b:cloud'])
    expect(parseList('')).toEqual([])
  })
  it('serializes with ", " separator', () => {
    expect(serializeList(['a', 'b'])).toBe('a, b')
  })
  it('adds, removes, and moves', () => {
    expect(addItem(['a'], 'b')).toEqual(['a', 'b'])
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(move(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('addItem ignores blank/duplicate', () => {
    expect(addItem(['a'], '  ')).toEqual(['a'])
    expect(addItem(['a'], 'a')).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/model-list.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/model-list.ts`**

```ts
export function parseList(v: string): string[] {
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

export function serializeList(items: string[]): string {
  return items.join(', ')
}

export function addItem(items: string[], item: string): string[] {
  const t = item.trim()
  if (!t || items.includes(t)) return items
  return [...items, t]
}

export function removeAt(items: string[], i: number): string[] {
  return items.filter((_, idx) => idx !== i)
}

export function move(items: string[], from: number, to: number): string[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items
  }
  const next = [...items]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/model-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/model-list.ts selfhosted/model-manager/lib/__tests__/model-list.test.ts
git commit -m "feat(model-manager): comma model-list codec"
```

---

## Task 8: Diff computation + secret masking

**Files:**

- Create: `selfhosted/model-manager/lib/diff.ts`
- Test: `selfhosted/model-manager/lib/__tests__/diff.test.ts`

**Interfaces:**

- Produces:
  - type `Change = { key: string; kind: 'add' | 'change' | 'remove'; before?: string; after?: string; secret: boolean }`
  - `computeChanges(current: Record<string, string>, next: Record<string, string>): Change[]`
  - `renderDiff(changes: Change[]): string`
  - `MASK = '••••••'`
- `secret` is resolved via `specByKey(key)?.type === 'secret'`. Consumed by preview route (Task 13) and review modal (Task 17).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/diff.test.ts
import { describe, expect, it } from 'vitest'
import { computeChanges, MASK, renderDiff } from '../diff'

describe('diff', () => {
  it('detects add / change / remove', () => {
    const c = computeChanges(
      { A: '1', B: 'x', RERANKER_API_TOKEN: 'old' },
      { A: '1', B: 'y', C: 'new', RERANKER_API_TOKEN: 'new' }
    )
    const byKey = Object.fromEntries(c.map(ch => [ch.key, ch]))
    expect(byKey.A).toBeUndefined() // unchanged
    expect(byKey.B.kind).toBe('change')
    expect(byKey.C.kind).toBe('add')
    expect(byKey.RERANKER_API_TOKEN.secret).toBe(true)
  })
  it('masks secret values in the rendered diff', () => {
    const out = renderDiff(
      computeChanges(
        { RERANKER_API_TOKEN: 'old' },
        { RERANKER_API_TOKEN: 'new' }
      )
    )
    expect(out).toContain(MASK)
    expect(out).not.toContain('old')
    expect(out).not.toContain('new')
  })
  it('shows non-secret values in the rendered diff', () => {
    const out = renderDiff(
      computeChanges(
        { OLLAMA_BASE_URL: 'http://a' },
        { OLLAMA_BASE_URL: 'http://b' }
      )
    )
    expect(out).toContain('http://a')
    expect(out).toContain('http://b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/diff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/diff.ts`**

```ts
import { specByKey } from './env-schema'

export const MASK = '••••••'

export interface Change {
  key: string
  kind: 'add' | 'change' | 'remove'
  before?: string
  after?: string
  secret: boolean
}

function isSecret(key: string): boolean {
  return specByKey(key)?.type === 'secret'
}

export function computeChanges(
  current: Record<string, string>,
  next: Record<string, string>
): Change[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  const changes: Change[] = []
  for (const key of keys) {
    const before = current[key]
    const after = next[key]
    if (before === after) continue
    const secret = isSecret(key)
    if (before === undefined) changes.push({ key, kind: 'add', after, secret })
    else if (after === undefined)
      changes.push({ key, kind: 'remove', before, secret })
    else changes.push({ key, kind: 'change', before, after, secret })
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key))
}

export function renderDiff(changes: Change[]): string {
  const show = (c: Change, v?: string) => (c.secret ? MASK : (v ?? ''))
  return changes
    .map(c => {
      if (c.kind === 'add') return `+ ${c.key}\n    + ${show(c, c.after)}`
      if (c.kind === 'remove') return `- ${c.key}\n    - ${show(c, c.before)}`
      return `~ ${c.key}\n    - ${show(c, c.before)}\n    + ${show(c, c.after)}`
    })
    .join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/diff.ts selfhosted/model-manager/lib/__tests__/diff.test.ts
git commit -m "feat(model-manager): change diff with secret masking"
```

---

## Task 9: Backup manager

**Files:**

- Create: `selfhosted/model-manager/lib/backups.ts`
- Test: `selfhosted/model-manager/lib/__tests__/backups.test.ts`

**Interfaces:**

- Produces (all async):
  - `writeBackup(envPath: string, now: Date): Promise<string>` → backup path
  - `listBackups(envPath: string): Promise<{ path: string; ts: string }[]>` (newest first)
  - `pruneBackups(envPath: string, keep: number): Promise<void>`
  - `restoreBackup(envPath: string, backupPath: string): Promise<void>`
- Backup name: `${envPath}.bak.${iso}` where `iso = now.toISOString().replace(/[:.]/g, '-')`. Consumed by apply (Task 10) and backups route (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/backups.test.ts
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  listBackups,
  pruneBackups,
  restoreBackup,
  writeBackup
} from '../backups'

async function tmpEnv(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mm-'))
  const p = join(dir, '.env')
  await writeFile(p, 'A=1\n')
  return p
}

describe('backups', () => {
  it('writes a timestamped backup with the file contents', async () => {
    const p = await tmpEnv()
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    expect(bak).toBe(`${p}.bak.2026-07-17T05-00-00-000Z`)
    expect(await readFile(bak, 'utf8')).toBe('A=1\n')
  })
  it('lists newest first and prunes to keep', async () => {
    const p = await tmpEnv()
    await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeBackup(p, new Date('2026-07-17T06:00:00.000Z'))
    await writeBackup(p, new Date('2026-07-17T07:00:00.000Z'))
    let list = await listBackups(p)
    expect(list).toHaveLength(3)
    expect(list[0].ts > list[1].ts).toBe(true)
    await pruneBackups(p, 2)
    list = await listBackups(p)
    expect(list).toHaveLength(2)
    expect(list[0].ts).toContain('07-00-00') // kept newest two
  })
  it('restores a backup over the env file', async () => {
    const p = await tmpEnv()
    const bak = await writeBackup(p, new Date('2026-07-17T05:00:00.000Z'))
    await writeFile(p, 'A=2\n')
    await restoreBackup(p, bak)
    expect(await readFile(p, 'utf8')).toBe('A=1\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/backups.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/backups.ts`**

```ts
import { copyFile, readdir, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export async function writeBackup(envPath: string, now: Date): Promise<string> {
  const bak = `${envPath}.bak.${stamp(now)}`
  await copyFile(envPath, bak)
  return bak
}

export async function listBackups(
  envPath: string
): Promise<{ path: string; ts: string }[]> {
  const dir = dirname(envPath)
  const prefix = `${basename(envPath)}.bak.`
  const entries = await readdir(dir)
  return entries
    .filter(e => e.startsWith(prefix))
    .map(e => ({ path: join(dir, e), ts: e.slice(prefix.length) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
}

export async function pruneBackups(
  envPath: string,
  keep: number
): Promise<void> {
  const list = await listBackups(envPath)
  for (const b of list.slice(keep)) await unlink(b.path)
}

export async function restoreBackup(
  envPath: string,
  backupPath: string
): Promise<void> {
  await copyFile(backupPath, envPath)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/backups.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/backups.ts selfhosted/model-manager/lib/__tests__/backups.test.ts
git commit -m "feat(model-manager): timestamped .env backup/list/prune/restore"
```

---

## Task 10: Command runner + apply orchestrator

**Files:**

- Create: `selfhosted/model-manager/lib/exec.ts`
- Create: `selfhosted/model-manager/lib/apply.ts`
- Test: `selfhosted/model-manager/lib/__tests__/exec.test.ts`
- Test: `selfhosted/model-manager/lib/__tests__/apply.test.ts`

**Interfaces:**

- Produces (`exec.ts`):
  - type `RunResult = { code: number; stdout: string; stderr: string }`
  - interface `Runner { run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; input?: string }): Promise<RunResult> }`
  - `realRunner: Runner`
- Produces (`apply.ts`):
  - type `ApplyEvent = { step: string; status: 'start' | 'ok' | 'fail'; detail?: string }`
  - interface `ApplyPlan { askEnvText: string; touchedTargets: ('ask' | 'reranker')[]; rerankerEnvText?: string }`
  - `applyPlan(plan, deps, emit): Promise<{ ok: boolean; backupPath: string }>`
  - `rollback(deps, backupPath, emit): Promise<{ ok: boolean }>`
  - interface `ApplyDeps { runner: Runner; config: ToolConfig; writeAskEnv(text): Promise<void>; sleep(ms): Promise<void> }`
- Consumed by the apply/restore routes (Task 13).

- [ ] **Step 1: Write the failing test for `exec.ts`**

```ts
// lib/__tests__/exec.test.ts
import { describe, expect, it } from 'vitest'
import { realRunner } from '../exec'

describe('realRunner', () => {
  it('captures stdout and exit code', async () => {
    const r = await realRunner.run('node', ['-e', "process.stdout.write('hi')"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('hi')
  })
  it('passes input on stdin', async () => {
    const r = await realRunner.run(
      'node',
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: 'piped' }
    )
    expect(r.stdout).toBe('piped')
  })
  it('reports non-zero exit', async () => {
    const r = await realRunner.run('node', ['-e', 'process.exit(3)'])
    expect(r.code).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/exec.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/exec.ts`**

```ts
import { spawn } from 'child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface Runner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; input?: string }
  ): Promise<RunResult>
}

export const realRunner: Runner = {
  run(cmd, args, opts = {}) {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      if (opts.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      }
      child.stdout.on('data', d => (stdout += d.toString()))
      child.stderr.on('data', d => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', code => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
      if (opts.input !== undefined) child.stdin.end(opts.input)
      else child.stdin.end()
    })
  }
}
```

- [ ] **Step 4: Run exec test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/exec.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `apply.ts`**

```ts
// lib/__tests__/apply.test.ts
import { describe, expect, it, vi } from 'vitest'
import { applyPlan, type ApplyDeps } from '../apply'
import type { RunResult } from '../exec'
import type { ToolConfig } from '../config'

const config: ToolConfig = {
  askEnvPath: '/ask/.env',
  askComposeFile: '/ask/docker-compose.yaml',
  askService: 'ask',
  backupKeep: 20,
  reranker: {
    sshTarget: 'u@h',
    sshKey: '/keys/k',
    remoteDir: '/srv/reranker',
    envFile: '.env',
    service: 'reranker'
  }
}

function deps(runImpl: (cmd: string, args: string[]) => RunResult): {
  d: ApplyDeps
  writes: string[]
  calls: string[][]
} {
  const writes: string[] = []
  const calls: string[][] = []
  const d: ApplyDeps = {
    config,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args])
        return runImpl(cmd, args)
      }
    },
    writeAskEnv: async text => {
      writes.push(text)
    },
    sleep: async () => {},
    backup: async () => '/ask/.env.bak.T'
  }
  return { d, writes, calls }
}

const ok: RunResult = { code: 0, stdout: 'healthy', stderr: '' }

describe('applyPlan', () => {
  it('writes env and restarts only ask when only ask targets changed', async () => {
    const { d, writes, calls } = deps(() => ok)
    const events: string[] = []
    const res = await applyPlan(
      { askEnvText: 'A=1\n', touchedTargets: ['ask'] },
      d,
      e => events.push(`${e.step}:${e.status}`)
    )
    expect(res.ok).toBe(true)
    expect(writes).toEqual(['A=1\n'])
    // restarts ask, never ssh
    expect(calls.some(c => c[0] === 'docker')).toBe(true)
    expect(calls.some(c => c[0] === 'ssh')).toBe(false)
  })

  it('also restarts reranker over ssh when reranker target changed', async () => {
    const { d, calls } = deps(() => ok)
    const res = await applyPlan(
      {
        askEnvText: 'A=1\n',
        touchedTargets: ['ask', 'reranker'],
        rerankerEnvText: 'RERANKER_MODEL=x\n'
      },
      d,
      () => {}
    )
    expect(res.ok).toBe(true)
    expect(calls.some(c => c[0] === 'ssh')).toBe(true)
  })

  it('reports failure independently — ask ok, reranker ssh fails', async () => {
    const { d } = deps(cmd =>
      cmd === 'ssh' ? { code: 255, stdout: '', stderr: 'no route' } : ok
    )
    const events: { step: string; status: string }[] = []
    const res = await applyPlan(
      {
        askEnvText: 'A=1\n',
        touchedTargets: ['ask', 'reranker'],
        rerankerEnvText: 'x'
      },
      d,
      e => events.push(e)
    )
    expect(res.ok).toBe(false)
    expect(
      events.some(e => e.step.startsWith('ask') && e.status === 'ok')
    ).toBe(true)
    expect(
      events.some(e => e.step.startsWith('reranker') && e.status === 'fail')
    ).toBe(true)
  })
})
```

Note: `ApplyDeps` also has `backup(): Promise<string>`; add it to the interface (below) — the test injects it.

- [ ] **Step 6: Run apply test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `lib/apply.ts`**

```ts
import type { ToolConfig } from './config'
import type { Runner } from './exec'

export type ApplyEvent = {
  step: string
  status: 'start' | 'ok' | 'fail'
  detail?: string
}

export interface ApplyPlan {
  askEnvText: string
  touchedTargets: ('ask' | 'reranker')[]
  rerankerEnvText?: string
}

export interface ApplyDeps {
  runner: Runner
  config: ToolConfig
  writeAskEnv(text: string): Promise<void>
  backup(): Promise<string>
  sleep(ms: number): Promise<void>
}

async function restartAsk(
  deps: ApplyDeps,
  emit: (e: ApplyEvent) => void
): Promise<boolean> {
  const { runner, config } = deps
  emit({ step: 'ask-restart', status: 'start' })
  const r = await runner.run(
    'docker',
    ['compose', '-f', config.askComposeFile, 'up', '-d', config.askService],
    { timeoutMs: 180_000 }
  )
  if (r.code !== 0) {
    emit({ step: 'ask-restart', status: 'fail', detail: r.stderr.slice(-2000) })
    return false
  }
  emit({ step: 'ask-restart', status: 'ok' })
  return true
}

async function restartReranker(
  deps: ApplyDeps,
  rerankerEnvText: string,
  emit: (e: ApplyEvent) => void
): Promise<boolean> {
  const { runner, config } = deps
  const rc = config.reranker
  if (!rc) {
    emit({
      step: 'reranker-restart',
      status: 'fail',
      detail: 'reranker SSH not configured'
    })
    return false
  }
  emit({ step: 'reranker-write', status: 'start' })
  const write = await runner.run(
    'ssh',
    [
      '-i',
      rc.sshKey,
      '-o',
      'StrictHostKeyChecking=accept-new',
      rc.sshTarget,
      `cat > ${rc.remoteDir}/${rc.envFile}`
    ],
    { input: rerankerEnvText, timeoutMs: 30_000 }
  )
  if (write.code !== 0) {
    emit({
      step: 'reranker-write',
      status: 'fail',
      detail: write.stderr.slice(-2000)
    })
    return false
  }
  emit({ step: 'reranker-write', status: 'ok' })

  emit({ step: 'reranker-restart', status: 'start' })
  const up = await runner.run(
    'ssh',
    [
      '-i',
      rc.sshKey,
      '-o',
      'StrictHostKeyChecking=accept-new',
      rc.sshTarget,
      `cd ${rc.remoteDir} && docker compose up -d ${rc.service}`
    ],
    { timeoutMs: 180_000 }
  )
  if (up.code !== 0) {
    emit({
      step: 'reranker-restart',
      status: 'fail',
      detail: up.stderr.slice(-2000)
    })
    return false
  }
  emit({ step: 'reranker-restart', status: 'ok' })
  return true
}

export async function applyPlan(
  plan: ApplyPlan,
  deps: ApplyDeps,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean; backupPath: string }> {
  emit({ step: 'backup', status: 'start' })
  const backupPath = await deps.backup()
  emit({ step: 'backup', status: 'ok', detail: backupPath })

  emit({ step: 'write', status: 'start' })
  await deps.writeAskEnv(plan.askEnvText)
  emit({ step: 'write', status: 'ok' })

  let ok = true
  if (plan.touchedTargets.includes('ask')) {
    if (!(await restartAsk(deps, emit))) ok = false
  }
  if (plan.touchedTargets.includes('reranker')) {
    if (!(await restartReranker(deps, plan.rerankerEnvText ?? '', emit)))
      ok = false
  }
  return { ok, backupPath }
}

export async function rollback(
  deps: ApplyDeps & { restoreAskEnv(backupPath: string): Promise<void> },
  backupPath: string,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean }> {
  emit({ step: 'rollback-restore', status: 'start' })
  await deps.restoreAskEnv(backupPath)
  emit({ step: 'rollback-restore', status: 'ok' })
  const ok = await restartAsk(deps, emit)
  return { ok }
}
```

- [ ] **Step 8: Run all lib tests**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/apply.test.ts lib/__tests__/exec.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add selfhosted/model-manager/lib/exec.ts selfhosted/model-manager/lib/apply.ts selfhosted/model-manager/lib/__tests__/exec.test.ts selfhosted/model-manager/lib/__tests__/apply.test.ts
git commit -m "feat(model-manager): command runner + apply orchestrator (local + cross-host)"
```

---

## Task 11: Connection testers

**Files:**

- Create: `selfhosted/model-manager/lib/connection-tests.ts`
- Test: `selfhosted/model-manager/lib/__tests__/connection-tests.test.ts`

**Interfaces:**

- Produces:
  - `testOllama(baseUrl: string, fetchFn?: typeof fetch): Promise<{ ok: boolean; models?: string[]; error?: string }>`
  - `testReranker(url: string, token: string, fetchFn?: typeof fetch): Promise<{ ok: boolean; error?: string }>`
- Consumed by the test route (Task 13) and the Test buttons / picker (Task 17).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/connection-tests.test.ts
import { describe, expect, it, vi } from 'vitest'
import { testOllama, testReranker } from '../connection-tests'

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('connection tests', () => {
  it('lists ollama models from /api/tags', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        jsonRes({ models: [{ name: 'granite4.1:8b' }, { name: 'llama3' }] })
      )
    const r = await testOllama('http://h:11434', f as unknown as typeof fetch)
    expect(r.ok).toBe(true)
    expect(r.models).toEqual(['granite4.1:8b', 'llama3'])
    expect(f).toHaveBeenCalledWith('http://h:11434/api/tags', expect.anything())
  })
  it('reports ollama failure', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await testOllama('http://h:11434', f as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('ECONNREFUSED')
  })
  it('checks reranker /health with bearer', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({ status: 'ok' }))
    const r = await testReranker(
      'http://h:8787',
      'tok',
      f as unknown as typeof fetch
    )
    expect(r.ok).toBe(true)
    const [, init] = f.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok'
    })
  })
  it('reports reranker non-200', async () => {
    const f = vi.fn().mockResolvedValue(jsonRes({}, 503))
    const r = await testReranker(
      'http://h:8787',
      'tok',
      f as unknown as typeof fetch
    )
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/connection-tests.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/connection-tests.ts`**

```ts
export async function testOllama(
  baseUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { models?: { name: string }[] }
    return { ok: true, models: (body.models ?? []).map(m => m.name) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function testReranker(
  url: string,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchFn(`${url.replace(/\/$/, '')}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/connection-tests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/connection-tests.ts selfhosted/model-manager/lib/__tests__/connection-tests.test.ts
git commit -m "feat(model-manager): ollama/reranker connection testers"
```

---

## Task 12: Auth — fail-closed password gate + session cookie

**Files:**

- Create: `selfhosted/model-manager/lib/auth.ts`
- Test: `selfhosted/model-manager/lib/__tests__/auth.test.ts`

**Interfaces:**

- Produces:
  - `isConfigured(env?): boolean`
  - `verifyPassword(input: string, env?): boolean` (constant-time; false if unset)
  - `makeSessionToken(env?): string`
  - `verifySessionToken(token: string | undefined, env?): boolean`
  - `SESSION_COOKIE = 'mm_session'`
- Consumed by the login route + proxy guard (Task 13).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/__tests__/auth.test.ts
import { describe, expect, it } from 'vitest'
import {
  isConfigured,
  makeSessionToken,
  verifyPassword,
  verifySessionToken
} from '../auth'

const withPw = { MODEL_MANAGER_PASSWORD: 'hunter2' } as NodeJS.ProcessEnv

describe('auth', () => {
  it('fail-closed: unset password ⇒ not configured, no verify', () => {
    expect(isConfigured({} as NodeJS.ProcessEnv)).toBe(false)
    expect(verifyPassword('anything', {} as NodeJS.ProcessEnv)).toBe(false)
  })
  it('verifies the correct password only', () => {
    expect(verifyPassword('hunter2', withPw)).toBe(true)
    expect(verifyPassword('wrong', withPw)).toBe(false)
  })
  it('session token round-trips and rejects tampering', () => {
    const t = makeSessionToken(withPw)
    expect(verifySessionToken(t, withPw)).toBe(true)
    expect(verifySessionToken(t + 'x', withPw)).toBe(false)
    expect(verifySessionToken(undefined, withPw)).toBe(false)
  })
  it('token from one secret fails under another', () => {
    const t = makeSessionToken(withPw)
    expect(
      verifySessionToken(t, {
        MODEL_MANAGER_PASSWORD: 'other'
      } as NodeJS.ProcessEnv)
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/auth.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/auth.ts`**

```ts
import { createHash, createHmac, timingSafeEqual } from 'crypto'

export const SESSION_COOKIE = 'mm_session'

export function isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.MODEL_MANAGER_PASSWORD
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest()
}

export function verifyPassword(
  input: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const pw = env.MODEL_MANAGER_PASSWORD
  if (!pw) return false
  return timingSafeEqual(sha256(input), sha256(pw))
}

function secret(env: NodeJS.ProcessEnv): string {
  return (
    env.MODEL_MANAGER_SESSION_SECRET || `derived:${env.MODEL_MANAGER_PASSWORD}`
  )
}

export function makeSessionToken(env: NodeJS.ProcessEnv = process.env): string {
  const payload = 'authenticated'
  const sig = createHmac('sha256', secret(env)).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifySessionToken(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!token || !isConfigured(env)) return false
  const expected = makeSessionToken(env)
  const a = sha256(token)
  const b = sha256(expected)
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/lib/auth.ts selfhosted/model-manager/lib/__tests__/auth.test.ts
git commit -m "feat(model-manager): fail-closed password gate + signed session"
```

---

## Task 13: Server routes + auth guard (proxy)

**Files:**

- Create: `selfhosted/model-manager/proxy.ts`
- Create: `selfhosted/model-manager/lib/env-io.ts` (fs read/atomic-write of the Ask `.env`)
- Create: `selfhosted/model-manager/lib/plan-builder.ts` (form values → `ApplyPlan` + change list)
- Create: `app/api/login/route.ts`, `app/api/logout/route.ts`, `app/api/config/route.ts`, `app/api/preview/route.ts`, `app/api/apply/route.ts`, `app/api/backups/route.ts`, `app/api/restore/route.ts`, `app/api/test/route.ts`
- Test: `selfhosted/model-manager/lib/__tests__/plan-builder.test.ts`
- Test: `selfhosted/model-manager/proxy.test.ts`

**Interfaces:**

- Produces (`lib/env-io.ts`): `readAskEnv(path): Promise<string>`, `writeAskEnvAtomic(path, text): Promise<void>` (temp + rename).
- Produces (`lib/plan-builder.ts`):
  - `buildPlan(currentText: string, edits: Record<string, string>): { plan: ApplyPlan; changes: Change[] }`
- Secret masking for the config payload is done inline in `app/api/config/route.ts` and `app/page.tsx` (real values for non-secret keys; a `secretSet` presence flag and empty string for secrets — a secret's plaintext is never sent to the browser).
- Consumes: everything from Tasks 5–12.

- [ ] **Step 1: Write the failing test for `plan-builder.ts`**

```ts
// lib/__tests__/plan-builder.test.ts
import { describe, expect, it } from 'vitest'
import { buildPlan } from '../plan-builder'

const CURRENT = `OLLAMA_BASE_URL=http://a:11434
CLASSIFIER_MODEL_ID=granite4.1:8b
RERANKER_URL=http://r:8787
RERANKER_MODEL=BAAI/bge-reranker-v2-m3
`

describe('buildPlan', () => {
  it('marks ask target when an ask var changes', () => {
    const { plan, changes } = buildPlan(CURRENT, {
      CLASSIFIER_MODEL_ID: 'qwen3:8b'
    })
    expect(plan.touchedTargets).toContain('ask')
    expect(plan.touchedTargets).not.toContain('reranker')
    expect(plan.askEnvText).toContain('CLASSIFIER_MODEL_ID=qwen3:8b')
    expect(changes.find(c => c.key === 'CLASSIFIER_MODEL_ID')?.kind).toBe(
      'change'
    )
  })
  it('marks reranker target and builds reranker env when RERANKER_MODEL changes', () => {
    const { plan } = buildPlan(CURRENT, {
      RERANKER_MODEL: 'BAAI/bge-reranker-base'
    })
    expect(plan.touchedTargets).toContain('reranker')
    expect(plan.rerankerEnvText).toContain(
      'RERANKER_MODEL=BAAI/bge-reranker-base'
    )
    // reranker model must NOT be written into Ask's .env
    expect(plan.askEnvText).not.toContain(
      'RERANKER_MODEL=BAAI/bge-reranker-base'
    )
  })
  it('no edits ⇒ no targets', () => {
    const { plan, changes } = buildPlan(CURRENT, {})
    expect(plan.touchedTargets).toHaveLength(0)
    expect(changes).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/plan-builder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/env-io.ts` and `lib/plan-builder.ts`**

`lib/env-io.ts`:

```ts
import { readFile, rename, writeFile } from 'fs/promises'

export async function readAskEnv(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export async function writeAskEnvAtomic(
  path: string,
  text: string
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}
```

`lib/plan-builder.ts`:

```ts
import type { Change } from './diff'
import { computeChanges } from './diff'
import { parseEnv, serializeEnv, setValue, toValueMap } from './env-file'
import { specByKey } from './env-schema'
import type { ApplyPlan } from './apply'

// RERANKER_MODEL lives in the reranker's own .env on nightfuryS. Everything
// else is an Ask .env var. The reranker's remote .env only needs the model
// line (its token line is managed on the box); we send a single-key file.
export function buildPlan(
  currentText: string,
  edits: Record<string, string>
): { plan: ApplyPlan; changes: Change[]; rerankerCurrentText?: string } {
  const currentDoc = parseEnv(currentText)
  const current = toValueMap(currentDoc)

  const next = { ...current }
  let askDoc = currentDoc
  const targets = new Set<'ask' | 'reranker'>()
  let rerankerModel: string | undefined

  for (const [key, value] of Object.entries(edits)) {
    if (current[key] === value) continue
    next[key] = value
    const target = specByKey(key)?.target ?? 'ask'
    if (target === 'reranker') {
      targets.add('reranker')
      if (key === 'RERANKER_MODEL') rerankerModel = value
    } else {
      targets.add('ask')
      askDoc = setValue(askDoc, key, value)
    }
  }

  const changes = computeChanges(current, next)
  const plan: ApplyPlan = {
    askEnvText: serializeEnv(askDoc),
    touchedTargets: [...targets],
    rerankerEnvText:
      rerankerModel !== undefined
        ? `RERANKER_MODEL=${rerankerModel}\n`
        : undefined
  }
  return { plan, changes }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test lib/__tests__/plan-builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the auth guard `proxy.ts` + its test**

`proxy.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server'
import { isConfigured, SESSION_COOKIE, verifySessionToken } from '@/lib/auth'

const PUBLIC_PATHS = ['/login', '/api/login', '/api/health']

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl
  if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next()
  }
  if (!isConfigured()) {
    return new NextResponse(
      'Model manager is not configured (set MODEL_MANAGER_PASSWORD)',
      {
        status: 503
      }
    )
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!verifySessionToken(token)) {
    if (pathname.startsWith('/api/'))
      return new NextResponse('Unauthorized', { status: 401 })
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
}
```

`proxy.test.ts`:

```ts
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { makeSessionToken } from '@/lib/auth'
import { proxy } from './proxy'

const req = (path: string, cookie?: string) => {
  const r = new NextRequest(new URL(`http://localhost${path}`))
  if (cookie) r.cookies.set('mm_session', cookie)
  return r
}

describe('proxy guard', () => {
  it('503 when password unset (fail-closed)', () => {
    delete process.env.MODEL_MANAGER_PASSWORD
    expect(proxy(req('/')).status).toBe(503)
  })
  it('redirects unauthenticated page requests to /login', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    const res = proxy(req('/'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })
  it('401 for unauthenticated api requests', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    expect(proxy(req('/api/config')).status).toBe(401)
  })
  it('allows a valid session', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    const res = proxy(req('/api/config', makeSessionToken()))
    expect(res.status).toBe(200) // NextResponse.next()
  })
  it('always allows /login and /api/health', () => {
    process.env.MODEL_MANAGER_PASSWORD = 'pw'
    expect(proxy(req('/login')).status).toBe(200)
    expect(proxy(req('/api/health')).status).toBe(200)
  })
})
```

- [ ] **Step 6: Run the proxy test**

Run: `cd selfhosted/model-manager && bun run test proxy.test.ts`
Expected: PASS.

- [ ] **Step 7: Implement the route handlers**

`app/api/login/route.ts`:

```ts
import { SESSION_COOKIE, makeSessionToken, verifyPassword } from '@/lib/auth'

export async function POST(req: Request) {
  const { password } = (await req.json()) as { password?: string }
  if (!password || !verifyPassword(password)) {
    return new Response('Invalid', { status: 401 })
  }
  const res = Response.json({ ok: true })
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${makeSessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`
  )
  return res
}
```

`app/api/logout/route.ts`:

```ts
import { SESSION_COOKIE } from '@/lib/auth'
export async function POST() {
  const res = Response.json({ ok: true })
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`
  )
  return res
}
```

`app/api/config/route.ts` — return current values, masking secrets (never send a secret's plaintext to the browser; send `isSet` instead):

```ts
import { toValueMap, parseEnv } from '@/lib/env-file'
import { REGISTRY, specByKey } from '@/lib/env-schema'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'

export async function GET() {
  const cfg = getToolConfig()
  const map = toValueMap(parseEnv(await readAskEnv(cfg.askEnvPath)))
  const values: Record<string, string> = {}
  const secretSet: Record<string, boolean> = {}
  for (const s of REGISTRY) {
    const v = map[s.key]
    if (s.type === 'secret') {
      secretSet[s.key] = !!v // presence only, never the value
      values[s.key] = ''
    } else {
      values[s.key] = v ?? ''
    }
  }
  return Response.json({
    values,
    secretSet,
    rerankerManaged: !!cfg.reranker
  })
}
```

`app/api/preview/route.ts`:

```ts
import { buildPlan } from '@/lib/plan-builder'
import { renderDiff } from '@/lib/diff'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'

export async function POST(req: Request) {
  const { edits } = (await req.json()) as { edits: Record<string, string> }
  const cfg = getToolConfig()
  const current = await readAskEnv(cfg.askEnvPath)
  const { changes, plan } = buildPlan(current, edits)
  return Response.json({
    diff: renderDiff(changes),
    targets: plan.touchedTargets
  })
}
```

`app/api/apply/route.ts` — streams NDJSON `ApplyEvent`s:

```ts
import { applyPlan, type ApplyEvent, type ApplyDeps } from '@/lib/apply'
import { buildPlan } from '@/lib/plan-builder'
import { getToolConfig } from '@/lib/config'
import { readAskEnv, writeAskEnvAtomic } from '@/lib/env-io'
import { realRunner } from '@/lib/exec'
import { writeBackup, pruneBackups } from '@/lib/backups'

export async function POST(req: Request) {
  const { edits } = (await req.json()) as { edits: Record<string, string> }
  const cfg = getToolConfig()
  const current = await readAskEnv(cfg.askEnvPath)
  const { plan } = buildPlan(current, edits)

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const emit = (e: ApplyEvent) =>
        controller.enqueue(enc.encode(JSON.stringify(e) + '\n'))
      const deps: ApplyDeps = {
        runner: realRunner,
        config: cfg,
        writeAskEnv: t => writeAskEnvAtomic(cfg.askEnvPath, t),
        backup: async () => {
          const p = await writeBackup(cfg.askEnvPath, new Date())
          await pruneBackups(cfg.askEnvPath, cfg.backupKeep)
          return p
        },
        sleep: ms => new Promise(r => setTimeout(r, ms))
      }
      try {
        const res = await applyPlan(plan, deps, emit)
        emit({
          step: 'done',
          status: res.ok ? 'ok' : 'fail',
          detail: res.backupPath
        })
      } catch (e) {
        emit({
          step: 'done',
          status: 'fail',
          detail: e instanceof Error ? e.message : String(e)
        })
      } finally {
        controller.close()
      }
    }
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' }
  })
}
```

`app/api/backups/route.ts`:

```ts
import { listBackups } from '@/lib/backups'
import { getToolConfig } from '@/lib/config'

export async function GET() {
  const cfg = getToolConfig()
  return Response.json({ backups: await listBackups(cfg.askEnvPath) })
}
```

`app/api/restore/route.ts`:

```ts
import { restoreBackup } from '@/lib/backups'
import { rollback, type ApplyDeps } from '@/lib/apply'
import { getToolConfig } from '@/lib/config'
import { writeAskEnvAtomic, readAskEnv } from '@/lib/env-io'
import { realRunner } from '@/lib/exec'

export async function POST(req: Request) {
  const { backupPath } = (await req.json()) as { backupPath: string }
  const cfg = getToolConfig()
  const events: unknown[] = []
  const deps: ApplyDeps & { restoreAskEnv(p: string): Promise<void> } = {
    runner: realRunner,
    config: cfg,
    writeAskEnv: t => writeAskEnvAtomic(cfg.askEnvPath, t),
    restoreAskEnv: async p => {
      await restoreBackup(cfg.askEnvPath, p)
    },
    backup: async () => '',
    sleep: ms => new Promise(r => setTimeout(r, ms))
  }
  const res = await rollback(deps, backupPath, e => events.push(e))
  return Response.json({ ok: res.ok, events })
}
```

`app/api/test/route.ts` — runs a connection test against **pending** values from the request body:

```ts
import { testOllama, testReranker } from '@/lib/connection-tests'

export async function POST(req: Request) {
  const body = (await req.json()) as
    | { kind: 'ollama'; baseUrl: string }
    | { kind: 'reranker'; url: string; token: string }
  if (body.kind === 'ollama')
    return Response.json(await testOllama(body.baseUrl))
  return Response.json(await testReranker(body.url, body.token))
}
```

- [ ] **Step 8: Run gates**

Run: `cd selfhosted/model-manager && bun run test && bun run typecheck && bun run build`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add selfhosted/model-manager/proxy.ts selfhosted/model-manager/proxy.test.ts selfhosted/model-manager/lib/env-io.ts selfhosted/model-manager/lib/plan-builder.ts selfhosted/model-manager/lib/__tests__/plan-builder.test.ts selfhosted/model-manager/app/api
git commit -m "feat(model-manager): auth guard + config/preview/apply/backups/restore/test routes"
```

---

## Task 14: shadcn primitives + login page

**Files:**

- Create: `selfhosted/model-manager/components/ui/{button,input,label,switch,select,dialog,card,tabs,alert-dialog}.tsx` (copied from Ask)
- Create: `app/login/page.tsx`
- Test: `selfhosted/model-manager/app/login/__tests__/login.test.tsx`

**Interfaces:**

- Produces: the UI primitives used by all later components; a working login page that POSTs `/api/login` and redirects to `/` on success.

- [ ] **Step 1: Copy the shadcn primitives from Ask**

Copy each file from `../../components/ui/<name>.tsx` into
`selfhosted/model-manager/components/ui/<name>.tsx` for: `button`, `input`,
`label`, `switch`, `select`, `dialog`, `card`, `tabs`, `alert-dialog`. These
depend only on `@/lib/utils` (`cn`, created in Task 3) and the Radix packages
already in `package.json`. Do not import anything from Ask.

Run: `cd selfhosted/model-manager && bun run typecheck`
Expected: clean (add any missing Radix dep the copied files import, then re-run).

- [ ] **Step 2: Write the failing login test**

```tsx
// app/login/__tests__/login.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import LoginPage from '../page'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

describe('login page', () => {
  beforeEach(() => {
    push.mockReset()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    )
  })
  it('submits password and redirects home on success', async () => {
    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'pw' }
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'))
    expect(fetch).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({ method: 'POST' })
    )
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test app/login/__tests__/login.test.tsx`
Expected: FAIL — page not implemented.

- [ ] **Step 4: Implement `app/login/page.tsx`**

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    if (res.ok) router.push('/')
    else setError('Invalid password')
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">Ask Model Manager</h1>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test app/login/__tests__/login.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add selfhosted/model-manager/components/ui selfhosted/model-manager/app/login
git commit -m "feat(model-manager): shadcn primitives + login page"
```

---

## Task 15: Field renderers + category form shell

**Files:**

- Create: `selfhosted/model-manager/components/field.tsx`
- Create: `selfhosted/model-manager/components/config-form.tsx`
- Create: `app/page.tsx` (loads `/api/config`, renders the form)
- Test: `selfhosted/model-manager/components/__tests__/field.test.tsx`

**Interfaces:**

- Produces:
  - `<Field spec value onChange secretSet />` renders the right control per `spec.type` and shows inline validation.
  - `<ConfigForm initial />` groups `REGISTRY` by category/group with a left nav; holds the edit state; exposes changed edits.
- Consumes: `REGISTRY`, `CATEGORIES`, validators (Task 5); model-list editor (Task 16, imported next task).

- [ ] **Step 1: Write the failing test**

```tsx
// components/__tests__/field.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Field } from '../field'
import { specByKey } from '@/lib/env-schema'

describe('Field', () => {
  it('renders a url input and reports changes', () => {
    const onChange = vi.fn()
    render(
      <Field
        spec={specByKey('OLLAMA_BASE_URL')!}
        value="http://a"
        onChange={onChange}
        isSecretSet={false}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'http://b' }
    })
    expect(onChange).toHaveBeenCalledWith('http://b')
  })
  it('shows a validation error for bad url', () => {
    render(
      <Field
        spec={specByKey('OLLAMA_BASE_URL')!}
        value="nope"
        onChange={() => {}}
        isSecretSet={false}
      />
    )
    expect(screen.getByText(/must be an http/i)).toBeInTheDocument()
  })
  it('renders an enum as a listbox with the allowed options', () => {
    render(
      <Field
        spec={specByKey('EMBEDDING_MODEL')!}
        value=""
        onChange={() => {}}
        isSecretSet={false}
      />
    )
    expect(screen.getByText(/embedding model/i)).toBeInTheDocument()
  })
  it('masks a secret that is set', () => {
    render(
      <Field
        spec={specByKey('RERANKER_API_TOKEN')!}
        value=""
        onChange={() => {}}
        isSecretSet
      />
    )
    expect(screen.getByPlaceholderText(/unchanged/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/field.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `components/field.tsx`**

```tsx
'use client'

import { EnvVarSpec } from '@/lib/env-schema'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ModelListEditor } from './model-list-editor'

export function Field({
  spec,
  value,
  onChange,
  isSecretSet
}: {
  spec: EnvVarSpec
  value: string
  onChange: (v: string) => void
  isSecretSet: boolean
}) {
  const error = spec.validate && value.trim() ? spec.validate(value) : null

  return (
    <div className="space-y-1.5 py-2">
      <Label htmlFor={spec.key} className="text-sm font-medium">
        {spec.label}{' '}
        <span className="text-xs font-normal text-muted-foreground">
          {spec.key}
        </span>
      </Label>

      {spec.type === 'bool' ? (
        <Switch
          checked={value === 'true'}
          onCheckedChange={c => onChange(c ? 'true' : 'false')}
        />
      ) : spec.type === 'enum' ? (
        <select
          id={spec.key}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value}
          onChange={e => onChange(e.target.value)}
        >
          <option value="">—</option>
          {spec.enumValues!.map(o => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : spec.type === 'model-list' ? (
        <ModelListEditor value={value} onChange={onChange} />
      ) : (
        <Input
          id={spec.key}
          type={spec.type === 'secret' ? 'password' : 'text'}
          value={value}
          placeholder={
            spec.type === 'secret' && isSecretSet
              ? '•••••• (unchanged — type to replace)'
              : spec.default
          }
          onChange={e => onChange(e.target.value)}
        />
      )}

      {spec.help && (
        <p className="text-xs text-muted-foreground">{spec.help}</p>
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 4: Implement `components/config-form.tsx` and `app/page.tsx`**

`components/config-form.tsx`:

```tsx
'use client'

import { useMemo, useState } from 'react'
import { CATEGORIES, Category, REGISTRY } from '@/lib/env-schema'
import { Field } from './field'
import { ApplyBar } from './apply-bar'

export interface ConfigData {
  values: Record<string, string>
  secretSet: Record<string, boolean>
  rerankerManaged: boolean
}

export function ConfigForm({ initial }: { initial: ConfigData }) {
  const [active, setActive] = useState<Category>('models')
  const [edits, setEdits] = useState<Record<string, string>>({})

  const value = (key: string) =>
    key in edits ? edits[key] : (initial.values[key] ?? '')

  const changed = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(edits).filter(
          ([k, v]) => v !== (initial.values[k] ?? '')
        )
      ),
    [edits, initial.values]
  )

  const specs = REGISTRY.filter(s => s.category === active)
  const groups = [...new Set(specs.map(s => s.group ?? ''))]

  return (
    <div className="flex min-h-screen">
      <nav className="w-44 shrink-0 border-r p-3 space-y-1">
        {CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setActive(c)}
            className={`block w-full rounded-md px-3 py-1.5 text-left text-sm capitalize ${
              active === c ? 'bg-muted font-medium' : 'hover:bg-muted/50'
            }`}
          >
            {c}
          </button>
        ))}
      </nav>

      <main className="flex-1 p-6 pb-24 max-w-3xl">
        {groups.map(g => (
          <section key={g} className="mb-6">
            {g && (
              <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                {g}
              </h2>
            )}
            {specs
              .filter(s => (s.group ?? '') === g)
              .map(s => (
                <Field
                  key={s.key}
                  spec={s}
                  value={value(s.key)}
                  isSecretSet={!!initial.secretSet[s.key]}
                  onChange={v => setEdits(e => ({ ...e, [s.key]: v }))}
                />
              ))}
          </section>
        ))}
      </main>

      <ApplyBar edits={changed} />
    </div>
  )
}
```

`app/page.tsx`:

```tsx
import { ConfigForm, ConfigData } from '@/components/config-form'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'
import { parseEnv, toValueMap } from '@/lib/env-file'
import { REGISTRY } from '@/lib/env-schema'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const cfg = getToolConfig()
  const map = toValueMap(parseEnv(await readAskEnv(cfg.askEnvPath)))
  const values: Record<string, string> = {}
  const secretSet: Record<string, boolean> = {}
  for (const s of REGISTRY) {
    if (s.type === 'secret') {
      secretSet[s.key] = !!map[s.key]
      values[s.key] = ''
    } else values[s.key] = map[s.key] ?? ''
  }
  const initial: ConfigData = {
    values,
    secretSet,
    rerankerManaged: !!cfg.reranker
  }
  return <ConfigForm initial={initial} />
}
```

(The `ApplyBar` import resolves in Task 17; if running gates before Task 17, temporarily render `null`. Note it here so the reviewer knows the dependency.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/field.test.tsx`
Expected: PASS. (Skip `app/page.tsx` full build until `ModelListEditor` and `ApplyBar` exist — Tasks 16–17.)

- [ ] **Step 6: Commit**

```bash
git add selfhosted/model-manager/components/field.tsx selfhosted/model-manager/components/config-form.tsx selfhosted/model-manager/app/page.tsx selfhosted/model-manager/components/__tests__/field.test.tsx
git commit -m "feat(model-manager): field renderers + categorized config form"
```

---

## Task 16: Model-list editor

**Files:**

- Create: `selfhosted/model-manager/components/model-list-editor.tsx`
- Test: `selfhosted/model-manager/components/__tests__/model-list-editor.test.tsx`

**Interfaces:**

- Produces: `<ModelListEditor value: string onChange: (v: string) => void />` — renders each model as a row with up/down/remove, plus an add input; emits the serialized comma list. Uses `parseList/serializeList/addItem/removeAt/move` (Task 7).

> Reorder is implemented with up/down buttons (reliable + testable). Drag can be layered on later without changing the interface.

- [ ] **Step 1: Write the failing test**

```tsx
// components/__tests__/model-list-editor.test.tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ModelListEditor } from '../model-list-editor'

describe('ModelListEditor', () => {
  it('adds a model', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a:cloud" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText(/add model/i), {
      target: { value: 'b:cloud' }
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onChange).toHaveBeenCalledWith('a:cloud, b:cloud')
  })
  it('removes a model', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a:cloud, b:cloud" onChange={onChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(onChange).toHaveBeenCalledWith('b:cloud')
  })
  it('moves a model up', () => {
    const onChange = vi.fn()
    render(<ModelListEditor value="a, b" onChange={onChange} />)
    fireEvent.click(screen.getAllByRole('button', { name: /move up/i })[0]) // on 'b'
    expect(onChange).toHaveBeenCalledWith('b, a')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/model-list-editor.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `components/model-list-editor.tsx`**

```tsx
'use client'

import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { useState } from 'react'
import {
  addItem,
  move,
  parseList,
  removeAt,
  serializeList
} from '@/lib/model-list'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ModelListEditor({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const items = parseList(value)
  const [draft, setDraft] = useState('')
  const emit = (next: string[]) => onChange(serializeList(next))

  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={`${item}-${i}`} className="flex items-center gap-1">
          <span className="flex-1 truncate rounded bg-muted px-2 py-1 text-sm">
            {item}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="move up"
            disabled={i === 0}
            onClick={() => emit(move(items, i, i - 1))}
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="move down"
            disabled={i === items.length - 1}
            onClick={() => emit(move(items, i, i + 1))}
          >
            <ChevronDown className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="remove"
            onClick={() => emit(removeAt(items, i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1">
        <Input
          placeholder="Add model…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
        <Button
          type="button"
          size="icon"
          aria-label="add"
          onClick={() => {
            emit(addItem(items, draft))
            setDraft('')
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/model-list-editor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/components/model-list-editor.tsx selfhosted/model-manager/components/__tests__/model-list-editor.test.tsx
git commit -m "feat(model-manager): model-list editor (add/remove/reorder)"
```

---

## Task 17: Apply bar — review diff, apply with live status, backups

**Files:**

- Create: `selfhosted/model-manager/components/apply-bar.tsx`
- Test: `selfhosted/model-manager/components/__tests__/apply-bar.test.tsx`

**Interfaces:**

- Produces: `<ApplyBar edits: Record<string, string> />` — a sticky footer showing the change count; **Review** opens a dialog that fetches `/api/preview` (masked diff); **Apply** streams `/api/apply` and shows each `ApplyEvent`; a **Backups** button lists `/api/backups` and restores via `/api/restore`.
- Consumes: the routes from Task 13.

- [ ] **Step 1: Write the failing test**

```tsx
// components/__tests__/apply-bar.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplyBar } from '../apply-bar'

describe('ApplyBar', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ diff: '~ OLLAMA_BASE_URL', targets: ['ask'] }),
          {
            status: 200
          }
        )
      )
    )
  })
  it('shows the change count', () => {
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    expect(screen.getByText(/1 change/i)).toBeInTheDocument()
  })
  it('fetches and shows the masked diff on Review', async () => {
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/preview',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(await screen.findByText(/OLLAMA_BASE_URL/)).toBeInTheDocument()
  })
  it('is disabled with no changes', () => {
    render(<ApplyBar edits={{}} />)
    expect(screen.getByRole('button', { name: /review/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/apply-bar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `components/apply-bar.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'

type ApplyEvent = {
  step: string
  status: 'start' | 'ok' | 'fail'
  detail?: string
}

export function ApplyBar({ edits }: { edits: Record<string, string> }) {
  const count = Object.keys(edits).length
  const [diff, setDiff] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<ApplyEvent[]>([])
  const [applying, setApplying] = useState(false)

  async function review() {
    const res = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    })
    const body = (await res.json()) as { diff: string }
    setDiff(body.diff)
    setEvents([])
    setOpen(true)
  }

  async function apply() {
    setApplying(true)
    setEvents([])
    const res = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits })
    })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const l of lines.filter(Boolean))
        setEvents(e => [...e, JSON.parse(l)])
    }
    setApplying(false)
    const failed = events.some(e => e.status === 'fail')
    toast[failed ? 'error' : 'success'](
      failed ? 'Apply finished with errors' : 'Applied'
    )
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 flex items-center justify-end gap-3 border-t bg-background/95 px-6 py-3">
        <span className="text-sm text-muted-foreground">
          {count} change{count === 1 ? '' : 's'}
        </span>
        <Button onClick={review} disabled={count === 0}>
          Review
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review changes</DialogTitle>
          </DialogHeader>
          <pre className="max-h-72 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
            {diff}
          </pre>
          {events.length > 0 && (
            <ul className="max-h-40 overflow-auto text-xs">
              {events.map((e, i) => (
                <li
                  key={i}
                  className={e.status === 'fail' ? 'text-red-500' : ''}
                >
                  {e.step}: {e.status}
                  {e.detail ? ` — ${e.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={apply} disabled={applying}>
              {applying ? 'Applying…' : 'Save & Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
```

> Backups panel: add a second `Dialog` (a "Backups" button in the footer) that
> GETs `/api/backups` and POSTs `/api/restore` with the chosen `backupPath`,
> mirroring the review dialog. Implement it the same way; its test asserts the
> list renders and a restore POSTs the selected path.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/apply-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full app gates**

Run: `cd selfhosted/model-manager && bun run test && bun run typecheck && bun run lint && bun run format:check && bun run build`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add selfhosted/model-manager/components/apply-bar.tsx selfhosted/model-manager/components/__tests__/apply-bar.test.tsx
git commit -m "feat(model-manager): review/apply bar with live status + backups"
```

---

## Task 18: Connection-test buttons + /api/tags picker

**Files:**

- Modify: `selfhosted/model-manager/components/field.tsx` (add a Test button + model picker for testable fields)
- Create: `selfhosted/model-manager/components/test-button.tsx`
- Test: `selfhosted/model-manager/components/__tests__/test-button.test.tsx`

**Interfaces:**

- Produces: `<TestButton spec value tokenValue />` — for `spec.testable === 'ollama'` POSTs `/api/test` `{kind:'ollama', baseUrl}` and, on success, shows the returned model list (which the user can click to fill a nearby model field via an `onPick` callback); for `'reranker'` POSTs `{kind:'reranker', url, token}` and shows ok/error.

- [ ] **Step 1: Write the failing test**

```tsx
// components/__tests__/test-button.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestButton } from '../test-button'
import { specByKey } from '@/lib/env-schema'

describe('TestButton', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, models: ['granite4.1:8b'] }),
            { status: 200 }
          )
        )
    )
  })
  it('tests an ollama host and lists models', async () => {
    render(
      <TestButton spec={specByKey('OLLAMA_BASE_URL')!} value="http://h:11434" />
    )
    fireEvent.click(screen.getByRole('button', { name: /test/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/test', expect.anything())
    )
    expect(await screen.findByText('granite4.1:8b')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/test-button.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `components/test-button.tsx` and wire into `field.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { EnvVarSpec } from '@/lib/env-schema'
import { Button } from '@/components/ui/button'

export function TestButton({
  spec,
  value,
  tokenValue,
  onPick
}: {
  spec: EnvVarSpec
  value: string
  tokenValue?: string
  onPick?: (model: string) => void
}) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState('')

  async function run() {
    setState('testing')
    setError('')
    setModels([])
    const body =
      spec.testable === 'ollama'
        ? { kind: 'ollama', baseUrl: value }
        : { kind: 'reranker', url: value, token: tokenValue ?? '' }
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const r = (await res.json()) as {
      ok: boolean
      models?: string[]
      error?: string
    }
    setState(r.ok ? 'ok' : 'fail')
    if (r.models) setModels(r.models)
    if (r.error) setError(r.error)
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={run}
        disabled={!value}
      >
        {state === 'testing' ? 'Testing…' : 'Test'}
        {state === 'ok' && ' ✓'}
        {state === 'fail' && ' ✗'}
      </Button>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {models.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => onPick?.(m)}
              className="rounded bg-muted px-2 py-0.5 text-xs hover:bg-muted/70"
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

In `components/field.tsx`, render `<TestButton>` when `spec.testable` is set (below the input). For `ollama` fields, the returned model chips are informational; wiring `onPick` to a specific model field is optional polish.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd selfhosted/model-manager && bun run test components/__tests__/test-button.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add selfhosted/model-manager/components/test-button.tsx selfhosted/model-manager/components/field.tsx selfhosted/model-manager/components/__tests__/test-button.test.tsx
git commit -m "feat(model-manager): connection-test buttons + model picker"
```

---

## Task 19: Dockerfile, compose, README, .env.example

**Files:**

- Create: `selfhosted/model-manager/Dockerfile`
- Create: `selfhosted/model-manager/docker-compose.yaml`
- Create: `selfhosted/model-manager/.env.example`
- Create: `selfhosted/model-manager/README.md`

**Interfaces:**

- Produces: a runnable container that mounts Ask's `.env`, compose file, the Docker socket, and the SSH key.

- [ ] **Step 1: Create the Dockerfile (standalone Next output + docker CLI + ssh)**

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

FROM node:22-slim AS run
WORKDIR /app
# docker CLI (compose plugin) + ssh client for apply orchestration
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl openssh-client docker.io docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3939
CMD ["node", "server.js"]
```

- [ ] **Step 2: Create `docker-compose.yaml`**

```yaml
name: model-manager
services:
  model-manager:
    build: .
    container_name: model-manager
    env_file: .env
    ports:
      - '${MODEL_MANAGER_PORT:-3939}:3939'
    volumes:
      # Ask's config + compose so the tool can edit and recreate the ask service.
      - /home/nightfury/selfhosted/ask/.env:/ask/.env
      - /home/nightfury/selfhosted/ask/docker-compose.yaml:/ask/docker-compose.yaml:ro
      - /home/nightfury/selfhosted/ask:/ask/context:ro
      # Docker socket to run `docker compose up -d ask` on the host.
      - /var/run/docker.sock:/var/run/docker.sock
      # SSH key to reach nightfuryS for the reranker.
      - ${RERANKER_SSH_KEY_HOST:-./keys/nightfurys}:/keys/nightfurys:ro
    restart: unless-stopped
```

- [ ] **Step 3: Create `.env.example`**

```bash
# REQUIRED — unset ⇒ the app serves 503 (fail-closed).
MODEL_MANAGER_PASSWORD=
# Optional; derived from the password if unset.
MODEL_MANAGER_SESSION_SECRET=
MODEL_MANAGER_PORT=3939

# Paths inside the container (see compose volume mounts).
ASK_ENV_PATH=/ask/.env
ASK_COMPOSE_FILE=/ask/docker-compose.yaml
ASK_SERVICE=ask
MODEL_MANAGER_BACKUP_KEEP=20

# Cross-host reranker management (leave unset to disable — reranker model
# becomes read-only in the UI).
RERANKER_SSH_TARGET=
RERANKER_SSH_KEY=/keys/nightfurys
RERANKER_REMOTE_DIR=
RERANKER_ENV_FILE=.env
RERANKER_SERVICE=reranker
```

- [ ] **Step 4: Create `README.md`**

Write a README that states, prominently:

- **Purpose:** manage Ask's `.env` from a UI; write + backup + restart.
- **⚠️ Privilege warning:** this container has read-write access to Ask's
  `.env`, the host Docker socket, and an SSH key to nightfuryS — together
  effectively **root on the host**. Run it **only on the trusted host, on the
  LAN, behind `MODEL_MANAGER_PASSWORD`**. Never expose it to the internet.
- **Setup:** copy `.env.example` → `.env`, set the password, mount the SSH
  key, `docker compose up -d`.
- **Fail-closed:** unset password ⇒ 503.

- [ ] **Step 5: Build image + commit**

Run: `cd selfhosted/model-manager && docker build -t model-manager:local .`
Expected: image builds.

```bash
git add selfhosted/model-manager/Dockerfile selfhosted/model-manager/docker-compose.yaml selfhosted/model-manager/.env.example selfhosted/model-manager/README.md
git commit -m "feat(model-manager): Dockerfile, compose, README, .env.example"
```

---

## Task 20: Manual end-to-end verification (no prod, no push)

**Files:** none (verification only).

- [ ] **Step 1: Run the app locally against a COPY of Ask's `.env`**

```bash
cp /home/nightfury/selfhosted/ask/.env /tmp/ask.env.copy
cd selfhosted/model-manager
MODEL_MANAGER_PASSWORD=test ASK_ENV_PATH=/tmp/ask.env.copy bun run dev
```

Open `http://localhost:3939`. Expected: redirected to `/login`; wrong password rejected; `test` logs in.

- [ ] **Step 2: Verify read + validate + diff (safe — copy file, no restart)**

- Confirm every category renders and the Models cards show the real values from the copy.
- Change `OLLAMA_MODELS` (add/remove/reorder); change `CLASSIFIER_MODEL_ID`.
- Click **Review** → confirm the masked diff lists exactly those changes and that a secret field (e.g. `RERANKER_API_TOKEN`) shows `••••••`, never plaintext.
- Do **not** click Save & Apply here (it would try to restart containers). Instead verify the diff and the change count are correct.

- [ ] **Step 3: Verify apply against a throwaway compose (optional, isolated)**

If you want to exercise apply end-to-end without touching Ask: point
`ASK_COMPOSE_FILE` at a scratch compose whose `ask` service is a trivial
container, `ASK_ENV_PATH` at the copy, and click Save & Apply — confirm the
backup file appears next to the copy, the env is written, the live status
lists `backup → write → ask-restart: ok → done: ok`, and the Backups panel
lists+restores the backup.

- [ ] **Step 4: Confirm fail-closed**

```bash
cd selfhosted/model-manager && bun run build && (MODEL_MANAGER_PASSWORD= bun run start &) ; sleep 3
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3939/
```

Expected: `503`.

- [ ] **Step 5: Report results**

Summarize what was verified. Do not push or deploy — deployment (running the
container on the host, applying the two enabling changes to prod + nightfuryS)
is a separate, user-approved step.

---

## Task 21: Remove Ask's Models settings tab (gated)

**Do this only after Task 20 verifies the tool works and the user approves.**

**Files:**

- Modify: `components/settings-dialog.tsx` (remove `ModelsTab` and its nav entry)
- Modify: `components/__tests__/settings-dialog.test.tsx` (drop 'Models' from the reachable-tabs list)

**Interfaces:**

- Consumes: nothing new. Removes the read-only Models tab now that the standalone tool owns model config.

- [ ] **Step 1: Update the reachability test to no longer expect a Models tab**

In `components/__tests__/settings-dialog.test.tsx`, remove `'Models'` from the
array of labels asserted reachable.

- [ ] **Step 2: Run it to confirm it fails against current code**

Run: `bun run test components/__tests__/settings-dialog.test.tsx`
Expected: FAIL — the Models tab still renders / label list mismatch, depending on how the assertion reads. (If it passes trivially, proceed; the real change is removing the tab.)

- [ ] **Step 3: Remove `ModelsTab`**

In `components/settings-dialog.tsx`, delete the `ModelsTab` component
(lines ~296–344) and its entry in the `TABS` array (the `models` key). Remove
now-unused imports.

- [ ] **Step 4: Run gates**

Run: `bun run test && bun typecheck && bun lint && bun run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add components/settings-dialog.tsx components/__tests__/settings-dialog.test.tsx
git commit -m "feat(settings): remove read-only Models tab (superseded by model-manager UI)"
```

---

## Self-Review (completed during authoring)

**Spec coverage:**

- Standalone Next.js app, isolated, sibling location → Tasks 3, 19. ✓
- Env-schema registry (every var) → Task 5 (parity test enforces completeness). ✓
- `.env` engine: preserve comments/order/unknown, atomic write, backup, masked diff → Tasks 6, 8, 9 (backup), 13 (atomic write), 8 (diff). ✓
- Apply: local `ask` restart + cross-host reranker over SSH, health-wait, rollback, independent status → Task 10, routes in 13. ✓
- Connection tests (ollama `/api/tags`, reranker `/health`), server-side, pending values, picker → Tasks 11, 18. ✓
- Auth: fail-closed, constant-time, signed cookie, LAN-bound → Tasks 12, 13; LAN/privilege documented in Task 19 README. ✓
- UI: categorized form, typed fields, secret masking, model-list editor, review/apply/backups → Tasks 15, 16, 17. ✓
- Two one-time enabling changes → Tasks 1, 2. ✓
- Remove Ask's Models tab → Task 21. ✓

**Type consistency:** `ApplyDeps` includes `backup()` (used by the apply route
and the test) and, for `rollback`, `restoreAskEnv()`; `ApplyPlan` fields
(`askEnvText`, `touchedTargets`, `rerankerEnvText`) are consistent across Task
10, `buildPlan` (Task 13), and the routes. `EnvVarSpec.target` drives
`buildPlan`'s ask/reranker split and `applyPlan`'s restart branch. `Change`
shape is shared by diff (Task 8) and preview (Task 13).

**Placeholder scan:** the one intentional open-ended step is Task 5 Step 4
("add remaining keys until the parity test passes") — this is guarded by an
executable test, not a vague instruction, and the model/service planes are
specified in full. No other placeholders.
