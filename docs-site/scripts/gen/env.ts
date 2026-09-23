// env.json — every environment variable the app reads, where, and its default.


import {
  isRealEnvFile, isSecretName, parseCompose, read, redactValue, rootFiles,
  SECRET_PLACEHOLDER, walk
} from './lib'

const CODE_DIRS = ['app', 'lib', 'components', 'hooks', 'config']
const CODE_EXT = /\.(ts|tsx|js|mjs|cjs|mts)$/
const TEST_RE = /(__tests__|__mocks__|\.test\.|\.spec\.)/

type Read = { file: string; line: number; snippet?: string }
type ComposeRef = {
  file: string
  service?: string
  via: 'environment' | 'interpolation'
  value?: string
  default?: string
}
type EnvVar = {
  name: string
  category: string
  nextPublic: boolean
  secret: boolean
  codeDefault: string | null
  codeDefaults: string[]
  defaultHint: string | null
  reads: Read[]
  compose: ComposeRef[]
  example: { file: string; commented: boolean; value?: string } | null
}

const CATEGORIES: [string, RegExp][] = [
  ['auth', /AUTH|SUPABASE|ANONYMOUS|GUEST|CRON_SECRET|ADMIN|SESSION|LOGIN/],
  ['voice', /VOICE|TTS|WHISPER|STT|KOKORO|SPEAK/],
  ['imagegen', /REPLICATE|IMAGE|IMAGEGEN/],
  ['uploads', /UPLOAD|INGEST|FILE|CHUNK|PDF|R2_|S3_|STORAGE|FAST_PATH/],
  ['memory', /MEMORY|RECALL|CONSOLIDAT/],
  ['rerank', /RERANK|CROSS_ENCODER|PASSAGE|EMBED/],
  ['crawl', /CRAWL|ENRICH|FLARESOLVERR|FIRECRAWL|FETCH|LEGACY/],
  ['search', /SEARCH|SEARXNG|DEGOOG|TAVILY|BRAVE|LANGSEARCH|EXA|SERPER|JINA|SNIPPET|EXCERPT|QUALITY|DEDUP|DEPTH|ROUNDS|DISCOVER/],
  ['stream', /STREAM|GENERATION|TIMEOUT|ABORT|RESUM/],
  ['models', /MODEL|OLLAMA|OPENAI|ANTHROPIC|GOOGLE|GEMINI|AZURE|DEEPSEEK|GROQ|XAI|THINK|REASONING|CLASSIFIER|EXPANDER|TITLE|LLM|AI_GATEWAY|PROVIDER|COMPATIBLE/],
  ['infra', /DATABASE|POSTGRES|REDIS|UPSTASH|PORT|HOST|URL|NODE_ENV|DOCKER|NEXT_RUNTIME|HOSTNAME|LOG|PERF|LATENCY|TELEMETRY|SENTRY|VERCEL|CACHE|RATE|LIMIT|BUDGET/],
  ['ui', /NEXT_PUBLIC|THEME|WEATHER|GEO|QUOTE|UI_/]
]

function categorize(name: string): string {
  const n = name.replace(/^NEXT_PUBLIC_/, '')
  for (const [cat, re] of CATEGORIES) if (re.test(n)) return cat
  if (name.startsWith('NEXT_PUBLIC_')) return 'ui'
  return 'other'
}

const LITERAL =
  `'([^']*)'|"([^"]*)"|\`([^\`$]*)\`|(-?\\d[\\d_.]*)|(true|false)|([A-Z][A-Z0-9_]{2,})`

function literalValue(m: RegExpExecArray, base: number): string | undefined {
  for (let i = base; i < base + 5; i++) if (m[i] !== undefined) return m[i]
  return undefined
}

function resolveConst(src: string, ident: string): string | undefined {
  const re = new RegExp(
    `const\\s+${ident}\\s*(?::[^=]+)?=\\s*(?:${LITERAL})`
  )
  const m = re.exec(src)
  if (!m) return undefined
  return literalValue(m, 1)
}

function detectDefault(
  src: string,
  rest: string,
  following: string[],
  readVar?: string
): { def?: string; hint?: string } {
  const dm = new RegExp(
    `^(?:\\??\\.\\w+\\([^()]*\\))*\\s*\\)?\\s*(?:as\\s+[\\w.]+\\s*\\)?\\s*)?(?:\\?\\?|\\|\\|)\\s*(?:${LITERAL})`
  ).exec(rest)
  if (dm) {
    let def = literalValue(dm, 1)
    if (def === undefined && dm[6]) def = resolveConst(src, dm[6]) ?? dm[6]
    if (def !== undefined) return { def }
  }
  // Ternary fallback within the same statement, e.g.
  //   const n = Number(process.env.X)
  //   return Number.isFinite(n) && n > 0 ? n : 1500
  // Follow-up lines only count when they use the variable the read was
  // assigned to (`const raw = Number(process.env.X)` → lines mentioning raw).
  let sawTernary = rest.includes('?')
  for (const l of [rest, ...following]) {
    if (l !== rest && /^\s*(\}|(export|function)\b)/.test(l)) break
    const usesVar = l === rest || (readVar ? new RegExp(`\\b${readVar}\\b`).test(l) : false)
    // Guard-return fallback: `if (!Number.isFinite(raw) || raw < 1) return 3`
    const gm = new RegExp(`^\\s*if\\s*\\(.*\\)\\s*return\\s+(?:${LITERAL})\\s*;?\\s*$`).exec(l)
    if (l !== rest && usesVar && gm) {
      let def = literalValue(gm, 1)
      if (def === undefined && gm[6]) def = resolveConst(src, gm[6]) ?? gm[6]
      if (def !== undefined) return { def }
    }
    if (usesVar && l.includes('?')) sawTernary = true
    const tm = new RegExp(`:\\s*(?:${LITERAL})\\s*\\)?\\s*;?\\s*$`).exec(l)
    if (sawTernary && tm) {
      let def = literalValue(tm, 1)
      if (def === undefined && tm[6]) def = resolveConst(src, tm[6]) ?? tm[6]
      if (def !== undefined) return { def }
    }
  }
  const cm = /^\s*(!==|===|!=|==)\s*['"]([^'"]*)['"]/.exec(rest)
  if (cm) {
    const neg = cm[1].startsWith('!')
    return {
      hint: neg
        ? `on unless set to '${cm[2]}'`
        : `off unless set to '${cm[2]}'`
    }
  }
  return {}
}

function collectReads(vars: Map<string, EnvVar>) {
  const files = [
    ...CODE_DIRS.flatMap(d => walk(d, f => CODE_EXT.test(f) && !TEST_RE.test(f))),
    ...rootFiles(/^(instrumentation.*|next\.config\..*|proxy)\.(ts|mjs|js|mts)$/)
  ]
  const access = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])/g
  for (const file of files) {
    const src = read(file)
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      let m: RegExpExecArray | null
      access.lastIndex = 0
      while ((m = access.exec(line))) {
        const name = m[1] ?? m[2]
        const rest = line.slice(m.index + m[0].length)
        if (/^\s*=[^=]/.test(rest)) continue // assignment, not a read
        const v = ensure(vars, name)
        const r: Read = { file, line: i + 1 }
        if (!v.secret) r.snippet = trimmed.slice(0, 180)
        v.reads.push(r)
        const readVar = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=[^=]/.exec(line.slice(0, m.index))?.[1]
        const { def, hint } = detectDefault(src, rest, lines.slice(i + 1, i + 5), readVar)
        if (def !== undefined && !v.codeDefaults.includes(def)) v.codeDefaults.push(def)
        if (hint && !v.defaultHint) v.defaultHint = hint
      }
      const d = /\{([^}]*)\}\s*=\s*process\.env\b/.exec(line)
      if (d) {
        for (const part of d[1].split(',')) {
          const name = part.split(/[:=]/)[0].trim()
          if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            ensure(vars, name).reads.push({ file, line: i + 1 })
          }
        }
      }
    })
  }
}

function ensure(vars: Map<string, EnvVar>, name: string): EnvVar {
  let v = vars.get(name)
  if (!v) {
    v = {
      name,
      category: categorize(name),
      nextPublic: name.startsWith('NEXT_PUBLIC_'),
      secret: isSecretName(name),
      codeDefault: null,
      codeDefaults: [],
      defaultHint: null,
      reads: [],
      compose: [],
      example: null
    }
    vars.set(name, v)
  }
  return v
}

function collectCompose(vars: Map<string, EnvVar>, composeFiles: string[]) {
  for (const file of composeFiles) {
    const text = read(file)
    // ${VAR}, ${VAR:-default}, ${VAR-default} anywhere in the file.
    const interp = /\$\{([A-Z_][A-Z0-9_]*)(?::?-((?:[^{}]|\{[^}]*\})*))?\}/g
    const seen = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = interp.exec(text))) {
      const name = m[1]
      if (seen.has(name)) continue
      seen.add(name)
      const ref: ComposeRef = { file, via: 'interpolation' }
      if (m[2] !== undefined) ref.default = redactValue(name, m[2])
      ensure(vars, name).compose.push(ref)
    }
    const doc = parseCompose(text) as { services?: Record<string, any> }
    for (const [svc, def] of Object.entries(doc?.services ?? {})) {
      const env = def?.environment
      const entries: [string, string | undefined][] = Array.isArray(env)
        ? env.map((e: string) => {
            const [k, ...v] = String(e).split('=')
            return [k, v.length ? v.join('=') : undefined]
          })
        : Object.entries(env ?? {}).map(([k, v]) => [k, v == null ? undefined : String(v)])
      for (const [k, val] of entries) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) continue
        const ref: ComposeRef = { file, service: svc, via: 'environment' }
        if (val !== undefined) ref.value = redactValue(k, val)
        ensure(vars, k).compose.push(ref)
      }
    }
  }
}

function collectExamples(vars: Map<string, EnvVar>) {
  for (const file of rootFiles(/^\.env.*example$/)) {
    if (isRealEnvFile(file)) continue
    const lines = read(file).split('\n')
    for (const line of lines) {
      const m = /^\s*(#\s*)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line)
      if (!m) continue
      const name = m[2]
      const v = vars.get(name) ?? (m[1] ? undefined : ensure(vars, name))
      if (!v || v.example) continue
      const val = m[3].trim().replace(/^['"]|['"]$/g, '')
      v.example = { file, commented: Boolean(m[1]) }
      if (val && !/^\[.*\]$/.test(val)) v.example.value = redactValue(name, val)
    }
  }
}

export function generateEnv(composeFiles: string[]) {
  const vars = new Map<string, EnvVar>()
  collectReads(vars)
  collectCompose(vars, composeFiles)
  collectExamples(vars)
  const list = [...vars.values()]
    .filter(v => /^[A-Z_][A-Z0-9_]*$/.test(v.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const v of list) {
    if (v.secret) {
      v.codeDefaults = v.codeDefaults.length ? [SECRET_PLACEHOLDER] : []
    }
    v.codeDefault = v.codeDefaults[0] ?? null
    v.reads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  }
  return {
    generatedFrom: 'app/, lib/, components/, hooks/, config/, instrumentation*, next.config*, proxy.ts, docker-compose*.yaml, .env*.example',
    note: 'Values of secret-named variables are never emitted. Real .env files are never read.',
    count: list.length,
    vars: list
  }
}
