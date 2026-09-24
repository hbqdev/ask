// code-map.json — every source file in the repo (plus the sibling ingestor
// repo when present): kind, one-line purpose, exports, HTTP methods, reverse
// import edges ("used by") and the docs pages that mention it.
//
// Purpose, in priority order:
//   1. the file's header comment (first sentence),
//   2. the doc comment directly above its main export,
//   3. a structural derivation (systemd Description=, JSON manifest, SQL DDL),
//   4. data/code-map-overrides.json (hand-written one-liners).
// Exits non-zero when any file ends up without a purpose, so every new file
// must either carry a header comment or get an override entry.
//
// Only the one-liner is emitted — never file contents. `.env*` files are never
// read (see isRealEnvFile); `.env*.example` files are excluded as well.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { DATA_DIR, DOCS_SITE, isRealEnvFile, isSafeValue, REPO, SECRET_PLACEHOLDER, writeJson } from './lib'

const INGESTOR = path.resolve(REPO, '..', 'ingestor')
const MM = 'selfhosted/model-manager/'
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const MAX_PURPOSE = 200

/** Directories (repo-relative) whose tracked files are mapped. */
const ASK_DIRS = ['app', 'components', 'hooks', 'lib', 'scripts', 'fleet-boot', 'config', 'drizzle', 'selfhosted/model-manager']
/** Root-level files worth mapping (code + deploy config; not docs/lockfiles). */
const ROOT_FILE_RE = /^(.*\.(ts|mts|mjs|js)|Dockerfile|docker-compose.*\.ya?ml|searxng-.*\.ya?ml|.*\.toml|package\.json|tsconfig\.json|components\.json)$/

type Source = 'header' | 'jsdoc' | 'derived' | 'override'
type Project = 'ask' | 'model-manager' | 'ingestor'

interface Entry {
  path: string
  dir: string
  area: string
  project: Project
  kind: string
  purpose: string
  purposeSource: Source | null
  exports: string[]
  methods: string[]
  route: string | null
  usedBy: string[]
  tests: string[]
  docs: { page: string; title: string; section: string | null; anchor: string | null }[]
}

// ---------------------------------------------------------------- file list

function gitLs(cwd: string, args: string[]): string[] {
  try {
    return execFileSync('git', ['ls-files', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

const isTestFile = (p: string) =>
  /(^|\/)(__tests__|__snapshots__|__mocks__|fixtures|tests?)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p)

function include(p: string): boolean {
  const base = path.posix.basename(p)
  if (isRealEnvFile(p) || /^\.env/.test(base) || /\.env(\.|$)/.test(base)) return false
  if (isTestFile(p)) return false
  if (/(^|\/)node_modules\//.test(p)) return false
  if (/\.(lock|lockb|png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|wav|mp4|pdf|md|sample|example|jsonl|tsbuildinfo)$/i.test(base)) return false
  if (/^\.(gitignore|dockerignore|prettierignore|eslintignore|npmrc|nvmrc)$/.test(base)) return false
  if (/^drizzle\/meta\//.test(p)) return false // generated snapshots
  if (/^scripts\/eval\/results\//.test(p)) return false // experiment outputs
  if (/__pycache__/.test(p)) return false
  return true
}

function listFiles(): { files: string[]; tests: string[]; ingestor: boolean } {
  const tracked = gitLs(REPO, [...ASK_DIRS])
  const root = gitLs(REPO, []).filter(p => !p.includes('/') && ROOT_FILE_RE.test(p))
  let all = [...tracked, ...root]
  const ingestor = existsSync(path.join(INGESTOR, '.git')) || existsSync(path.join(INGESTOR, 'app'))
  if (ingestor) {
    let ing = gitLs(INGESTOR, [])
    if (!ing.length) ing = walkPlain(INGESTOR, '')
    all.push(...ing.map(p => `ingestor/${p}`))
  }
  all = [...new Set(all)].filter(p => existsSync(abs(p)))
  const tests = all.filter(p => isTestFile(p) && /\.([cm]?[jt]sx?|py)$/.test(p))
  return { files: all.filter(include).sort(), tests, ingestor }
}

function walkPlain(root: string, rel: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(path.join(root, rel)).sort()) {
    if (['.git', 'node_modules', '__pycache__'].includes(e)) continue
    const r = rel ? `${rel}/${e}` : e
    if (statSync(path.join(root, r)).isDirectory()) out.push(...walkPlain(root, r))
    else out.push(r)
  }
  return out
}

function abs(p: string): string {
  return p.startsWith('ingestor/') ? path.join(INGESTOR, p.slice('ingestor/'.length)) : path.join(REPO, p)
}

function readSrc(p: string): string {
  if (isRealEnvFile(p)) throw new Error(`refusing to read env file ${p}`)
  return readFileSync(abs(p), 'utf8')
}

// ---------------------------------------------------------------- classify

function projectOf(p: string): { project: Project; inner: string } {
  if (p.startsWith(MM)) return { project: 'model-manager', inner: p.slice(MM.length) }
  if (p.startsWith('ingestor/')) return { project: 'ingestor', inner: p.slice('ingestor/'.length) }
  return { project: 'ask', inner: p }
}

function areaOf(p: string): string {
  const { project, inner } = projectOf(p)
  if (project !== 'ask') return project
  return inner.includes('/') ? inner.split('/')[0] : '(root)'
}

function classify(p: string, src: string): string {
  const { project, inner } = projectOf(p)
  const base = path.posix.basename(inner)
  const ext = path.posix.extname(base)
  if (/^(vitest|jest)\.setup\.|^conftest\.py$/.test(base)) return 'test-helper'
  if (/^Dockerfile/.test(base)) return 'dockerfile'
  if (/^docker-compose.*\.ya?ml$/.test(base)) return 'compose'
  if (/\.(service|timer)$/.test(base)) return 'systemd-unit'
  if (ext === '.sql') return 'migration'
  if (ext === '.css') return 'stylesheet'
  if (
    /\.config\.[cm]?[jt]s$/.test(base) ||
    /^(package|tsconfig|components)\.json$/.test(base) ||
    /\.(toml|ya?ml)$/.test(base) ||
    base === 'requirements.txt'
  )
    return 'config'
  if (ext === '.json') return 'data'
  if (project === 'ingestor') return 'python-module'
  if (inner.startsWith('scripts/')) return 'script'
  if (inner.startsWith('fleet-boot/')) return 'ops-script'
  if (inner.startsWith('app/')) {
    if (/\/route\.[jt]s$/.test(inner)) return 'route-handler'
    if (/\/page\.[jt]sx?$/.test(inner)) return 'page'
    if (/\/layout\.[jt]sx?$/.test(inner)) return 'layout'
    if (/\/(loading|error|global-error|not-found|template|default)\.[jt]sx?$/.test(inner)) return 'route-boundary'
    if (/\/(opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[jt]sx?$/.test(inner)) return 'metadata'
  }
  if (/^proxy\.ts$|^middleware\.ts$/.test(inner)) return 'middleware'
  if (/^instrumentation/.test(inner)) return 'instrumentation'
  if (/^['"]use server['"]/m.test(src)) return 'server-action'
  if (inner.startsWith('hooks/') || inner.startsWith('lib/hooks/') || /^use-[\w-]+\.tsx?$/.test(base)) return 'hook'
  if (inner.startsWith('components/ui/')) return 'ui-primitive'
  if (/\.d\.ts$/.test(base) || inner.startsWith('lib/types/')) return 'types'
  if (ext === '.tsx') return 'component'
  if (/^drizzle\//.test(inner) || /(^|\/)schema\.ts$/.test(inner)) return 'db-schema'
  return 'lib-module'
}

function routeOf(p: string): string | null {
  const { project, inner } = projectOf(p)
  if (!/^app\/.*\/route\.[jt]s$/.test(inner)) return null
  const r =
    inner
      .replace(/^app/, '')
      .replace(/\/route\.[jt]s$/, '')
      .split('/')
      .filter(seg => !/^\(.*\)$/.test(seg))
      .map(seg =>
        seg
          .replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*?')
          .replace(/^\[\.\.\.(.+)\]$/, ':$1*')
          .replace(/^\[(.+)\]$/, ':$1')
      )
      .join('/') || '/'
  return project === 'ask' ? r : `${project}: ${r}`
}

// ---------------------------------------------------------------- purpose

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|resp|cf|al|No|Dr|Mr|v\d+(?:\.\d+)*))$/i

function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  const re = /[.!?](?=\s+(?:[A-Z(`"'*\d]|$)|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    const upTo = t.slice(0, m.index)
    if (ABBREV.test(upTo)) continue
    return clamp(t.slice(0, m.index + 1))
  }
  return clamp(t)
}

function clamp(s: string): string {
  s = s.trim()
  if (s.length <= MAX_PURPOSE) return s
  const cut = s.slice(0, MAX_PURPOSE - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > MAX_PURPOSE * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, '') + '…'
}

const PRAGMA =
  /^(eslint|@ts-|prettier-ignore|@vitest-environment|@jest-environment|istanbul|c8 |biome-ignore|shellcheck|syntax=|escape=|noqa|type:\s*ignore|pylint|global |jshint|#region|#endregion|region\b|endregion\b)/i

/** Is this comment text a usable description (not a pragma, divider, path echo or code)? */
function usable(text: string, p: string): boolean {
  const t = text.trim()
  if (t.length < 12) return false
  if (PRAGMA.test(t)) return false
  if (/^[-=*#_~\s/]+$/.test(t)) return false
  if (/^(copyright|license|spdx|todo|fixme|hack|xxx|based on|see|source|adapted from)\b/i.test(t)) return false
  if (/^\S*https?:\/\/\S+$/.test(t)) return false
  const base = path.posix.basename(p)
  if (t === p || t === base || t.replace(/[`'"]/g, '') === projectOf(p).inner) return false
  if (/^[\w$.]+\s*\(.*\)\s*;?$/.test(t) || /[;{]\s*$/.test(t) && !/\s\w+\s\w+\s/.test(t)) return false // commented-out code
  return true
}

/** Clean a raw comment block into one paragraph of prose. */
function cleanBlock(lines: string[]): string {
  const out: string[] = []
  for (let l of lines) {
    l = l.trim()
    if (/^@(file|fileoverview|module|overview|description)\b/.test(l)) l = l.replace(/^@\w+\s*/, '')
    if (/^@\w+/.test(l)) break // stop at JSDoc tags (@param, @returns, …)
    if (!l) {
      if (out.length) break // first paragraph only
      continue
    }
    if (PRAGMA.test(l)) continue
    if (/^[-=*#_~]{3,}$/.test(l)) continue
    out.push(l)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

/** Strip a leading "path/file.ts —" / "Name:" echo so the purpose reads cleanly. */
function stripEcho(text: string, p: string): string {
  const inner = projectOf(p).inner
  const base = path.posix.basename(p)
  for (const echo of [p, inner, base, base.replace(/\.\w+$/, '')]) {
    const esc = echo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^\`?${esc}\`?\\s*[—–:-]+\\s*`, 'i')
    if (re.test(text) && text.replace(re, '').length > 12) return text.replace(re, '')
  }
  return text
}

function finalize(text: string, p: string): string | null {
  if (!text || !usable(text, p)) return null
  const s = firstSentence(stripEcho(text, p))
  return usable(s, p) ? capitalize(s) : null
}

const capitalize = (s: string) => (/^[a-z]/.test(s) && !/^[a-z]+[A-Z(.]/.test(s) ? s[0].toUpperCase() + s.slice(1) : s)

/** Read one comment block starting at lines[i] (// or /* style). */
function readJsComment(lines: string[], i: number): { text: string[]; end: number } {
  const text: string[] = []
  if (lines[i].trim().startsWith('//')) {
    while (i < lines.length && lines[i].trim().startsWith('//')) text.push(lines[i++].trim().replace(/^\/\/+\s?/, ''))
    return { text, end: i }
  }
  let first = true
  while (i < lines.length) {
    const l = lines[i++].trim()
    const done = first ? l.slice(2).includes('*/') : l.includes('*/')
    text.push(
      l
        .replace(/\*\/\s*$/, '')
        .replace(first ? /^\/\*+!?\s?/ : /^\*+\s?/, '')
        .trim()
    )
    first = false
    if (done) break
  }
  return { text, end: i }
}

const JS_PREAMBLE_SKIP = /^(['"]use (client|server|strict)['"];?|#!.*)$/

const EXPORT_DECL_RE = /^export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum)?\s*([A-Za-z_$][\w$]*)?/
const NEXT_CONFIG_CONST = /^(maxDuration|dynamic|runtime|revalidate|fetchCache|preferredRegion|dynamicParams|metadata|viewport|config)$/

/**
 * Line indices of the file's MAIN export(s): the default export, an export
 * named after the file, the HTTP-method handlers of a route file, or the only
 * runtime export. Empty when there is no clear main export.
 */
function mainExportLines(src: string, p: string): Set<number> {
  const lines = src.split('\n')
  const base = path.posix.basename(p).replace(/\.[^.]+$/, '')
  const norm = (x: string) => x.replace(/[-_.]/g, '').toLowerCase()
  const decls: { idx: number; isDefault: boolean; kind: string; name: string }[] = []
  lines.forEach((l, idx) => {
    if (/^export\s+(\*|\{|type\s+\{)/.test(l)) return
    const m = EXPORT_DECL_RE.exec(l)
    if (!m || (!m[1] && !m[2])) return
    decls.push({ idx, isDefault: Boolean(m[1]), kind: m[2] ?? '', name: m[3] ?? '' })
  })
  const pick = (f: (d: (typeof decls)[number]) => boolean) => new Set(decls.filter(f).map(d => d.idx))
  let s = pick(d => d.isDefault)
  if (s.size) return s
  s = pick(d => Boolean(d.name) && norm(d.name) === norm(base))
  if (s.size) return s
  if (/(^|\/)route\.[jt]s$/.test(p)) {
    s = pick(d => METHODS.includes(d.name))
    if (s.size) return s
  }
  const runtime = decls.filter(d => !/^(interface|type)$/.test(d.kind) && !NEXT_CONFIG_CONST.test(d.name))
  if (runtime.length === 1) return new Set([runtime[0].idx])
  return new Set()
}

/** Header comment for JS/TS: the first usable comment in the file preamble. */
function jsHeader(src: string, p: string, main: Set<number>): string | null {
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (!line || JS_PREAMBLE_SKIP.test(line)) {
      i++
      continue
    }
    if (/^import\b/.test(line) || /^export\s+(\*|\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from)/.test(line)) {
      // multi-line import: skip until the `from '…'` / closing quote line
      if (!/['"]\s*;?\s*$/.test(line)) {
        while (i < lines.length && !/(from\s+['"][^'"]+['"]|^\s*['"][^'"]+['"])\s*;?\s*$/.test(lines[i])) i++
      }
      i++
      continue
    }
    if (line.startsWith('//') || line.startsWith('/*')) {
      const { text, end } = readJsComment(lines, i)
      const next = (lines[end] ?? '').trim()
      i = end
      const cleaned = cleanBlock(text)
      if (!cleaned || !usable(cleaned, p)) continue
      // A comment glued (no blank line) to a declaration documents THAT
      // declaration, not the file — unless the declaration is the main export.
      if (/^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(function|const|let|var|class|interface|type|enum)\b/.test(next) && !main.has(end)) return null
      return finalize(cleaned, p)
    }
    return null // first real code line: preamble over
  }
  return null
}

/** Doc comment directly above the main export. */
function jsExportDoc(src: string, p: string, main: Set<number>): string | null {
  const lines = src.split('\n')
  for (const idx of [...main].sort((a, b) => a - b)) {
    let j = idx - 1
    while (j >= 0 && /^\s*@\w/.test(lines[j])) j-- // decorators
    if (j < 0) continue
    const l = lines[j].trim()
    if (!(l.endsWith('*/') || l.startsWith('//'))) continue
    let start = j
    if (l.endsWith('*/')) {
      while (start > 0 && !lines[start].trim().startsWith('/*')) start--
    } else {
      while (start > 0 && lines[start - 1].trim().startsWith('//')) start--
    }
    const { text } = readJsComment(lines, start)
    const s = finalize(cleanBlock(text), p)
    if (s) return s
  }
  return null
}

/** Leading `#` comment block (shell, python, yaml, dockerfile, toml, requirements). */
function hashHeader(src: string, p: string): string | null {
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (!t || t.startsWith('#!') || /^#\s*-\*-/.test(t) || /^#\s*(syntax|escape|check)=/.test(t) || /^#\s*shellcheck/.test(t)) {
      i++
      continue
    }
    if (t.startsWith('#')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('#')) buf.push(lines[i++].trim().replace(/^#+\s?/, ''))
      const cleaned = cleanBlock(buf)
      const s = finalize(cleaned, p)
      if (s) return s
      continue
    }
    return null
  }
  return null
}

function pyHeader(src: string, p: string): string | null {
  const m = /^(?:\s*#[^\n]*\n|\s*\n)*\s*[rubRUB]?("""|''')([\s\S]*?)\1/.exec(src)
  if (m) {
    const s = finalize(cleanBlock(m[2].split('\n')), p)
    if (s) return s
  }
  return hashHeader(src, p)
}

function pyExportDoc(src: string, p: string): string | null {
  const m = /^(?:async\s+)?(?:def|class)\s+[A-Za-z]\w*[^\n]*:\s*\n\s+[rubRUB]?("""|''')([\s\S]*?)\1/m.exec(src)
  return m ? finalize(cleanBlock(m[2].split('\n')), p) : null
}

function sqlHeader(src: string, p: string): string | null {
  const buf: string[] = []
  for (const l of src.split('\n')) {
    const t = l.trim()
    if (!t && !buf.length) continue
    if (t.startsWith('--')) buf.push(t.replace(/^--+\s?/, ''))
    else break
  }
  return buf.length ? finalize(cleanBlock(buf), p) : null
}

function cssHeader(src: string, p: string): string | null {
  const m = /^\s*\/\*([\s\S]*?)\*\//.exec(src)
  return m ? finalize(cleanBlock(m[1].split('\n').map(l => l.replace(/^\s*\*\s?/, ''))), p) : null
}

/** Structural purposes for files that can't carry a comment (JSON, SQL, units). */
function derived(p: string, src: string, kind: string): string | null {
  const base = path.posix.basename(p)
  if (kind === 'systemd-unit') {
    const d = /^Description=(.+)$/m.exec(src)?.[1]?.trim()
    if (d) return clamp(`systemd ${base.endsWith('.timer') ? 'timer' : 'unit'}: ${d}`)
  }
  if (p.endsWith('.json')) {
    try {
      const j = JSON.parse(src)
      if (/^lib\/imagegen\/models\//.test(p) && j.modelPath) {
        const caps = Array.isArray(j.capabilities) ? j.capabilities.join('+') : 'generate'
        return clamp(`Image-generation model manifest for ${j.modelPath} (${caps}${j.tier ? `, ${j.tier} tier` : ''}): request field mapping, aspect ratios and defaults.`)
      }
      const c = Array.isArray(j._comment) ? j._comment.join(' ') : typeof j._comment === 'string' ? j._comment : typeof j.description === 'string' ? j.description : null
      if (c) {
        const s = finalize(c, p)
        if (s) return s
      }
    } catch {
      /* not JSON */
    }
  }
  if (kind === 'migration') {
    const tables = (re: RegExp) => [...new Set([...src.matchAll(re)].map(m => m[1].replace(/"/g, '').replace(/^public\./, '')))]
    const created = tables(/CREATE TABLE(?: IF NOT EXISTS)?\s+("?[\w.]+"?(?:\."?\w+"?)?)/gi)
    const altered = tables(/ALTER TABLE(?: ONLY)?(?: IF EXISTS)?\s+("?[\w.]+"?(?:\."?\w+"?)?)/gi).filter(t => !created.includes(t))
    const indexes = [...src.matchAll(/CREATE (?:UNIQUE )?INDEX/gi)].length
    const policies = [...src.matchAll(/CREATE POLICY/gi)].length
    const ext = tables(/CREATE EXTENSION(?: IF NOT EXISTS)?\s+("?[\w-]+"?)/gi)
    const parts: string[] = []
    if (ext.length) parts.push(`enables extension ${ext.join(', ')}`)
    if (created.length) parts.push(`creates ${list(created)}`)
    if (altered.length) parts.push(`alters ${list(altered)}`)
    if (indexes) parts.push(`${indexes} index${indexes > 1 ? 'es' : ''}`)
    if (policies) parts.push(`${policies} RLS polic${policies > 1 ? 'ies' : 'y'}`)
    if (parts.length) return clamp(`Drizzle migration ${base.replace(/\.sql$/, '')}: ${parts.join('; ')}.`)
  }
  return null
}

const list = (a: string[]) => (a.length > 5 ? `${a.slice(0, 5).join(', ')} +${a.length - 5} more` : a.join(', '))

/** Replace anything token-shaped that could be a credential. */
function scrub(s: string): string {
  s = s.replace(/\b(password|passwd|pass|pwd|token|secret|api[_-]?key)(\s*[:=]\s*)(['"]?)[^\s'",;]+\3/gi, `$1$2${SECRET_PLACEHOLDER}`)
  return s
    .split(/(\s+)/)
    .map(tok => {
      const t = tok.replace(/[`'",.;:()]+$/g, '').replace(/^[`'"(]+/, '')
      if (/\s/.test(tok) || t.length < 16) return tok
      // Identifiers and paths (`useFoo/useBar`, `lib/x/y.ts`) have no digits; real tokens do.
      if (/^[A-Za-z_$@./\-]+$/.test(t)) return tok
      return isSafeValue('purpose', t) ? tok : SECRET_PLACEHOLDER
    })
    .join('')
}

// ---------------------------------------------------------------- exports

function jsExports(src: string): string[] {
  const out = new Set<string>()
  for (const m of src.matchAll(/^export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.add(m[1] ? `${m[3]} (default)` : m[3])
  }
  for (const m of src.matchAll(/^export\s+default\s+(?!(?:async\s+)?(?:function|class|abstract)\b)([A-Za-z_$][\w$]*)?/gm)) {
    out.add(m[1] && !/^(async|new|await)$/.test(m[1]) ? `${m[1]} (default)` : 'default')
  }
  for (const m of src.matchAll(/^export\s+default\s+(?:async\s+)?function\s*\(/gm)) void m, out.add('default')
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}(?:\s+from\s+['"]([^'"]+)['"])?/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      if (name) out.add(name === 'default' ? 'default' : name)
    }
  }
  for (const m of src.matchAll(/^export\s+\*\s+(?:as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/gm)) out.add(m[1] ?? `* from ${m[2]}`)
  return [...out]
}

function pyExports(src: string): string[] {
  return [...new Set([...src.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)].map(m => m[1]))]
}

function methodsOf(src: string): string[] {
  return METHODS.filter(m =>
    new RegExp(`export\\s+(async\\s+)?(function\\s+${m}\\b|const\\s+${m}\\b)|export\\s*\\{[^}]*\\b${m}\\b`).test(src)
  )
}

// ---------------------------------------------------------------- imports

const JS_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.mts', '.cjs', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js']

function jsSpecifiers(src: string): string[] {
  const out: string[] = []
  const re = /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|vi\.mock\(\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3] ?? m[4])
  return out
}

function resolveJs(from: string, spec: string, known: Set<string>): string | null {
  let basePath: string
  if (spec.startsWith('@/')) basePath = (from.startsWith(MM) ? MM : '') + spec.slice(2)
  else if (spec.startsWith('.')) basePath = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))
  else return null
  for (const e of JS_EXT) if (known.has(basePath + e)) return basePath + e
  // `.js` specifier pointing at a `.ts` source
  const noExt = basePath.replace(/\.[cm]?js$/, '')
  for (const e of ['.ts', '.tsx']) if (known.has(noExt + e)) return noExt + e
  return null
}

function pySpecifiers(src: string): { mod: string; names: string[] }[] {
  const out: { mod: string; names: string[] }[] = []
  for (const m of src.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)\n]+)/gm)) out.push({ mod: m[1], names: m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) })
  for (const m of src.matchAll(/^\s*import\s+([\w.]+)/gm)) out.push({ mod: m[1], names: [] })
  return out
}

function resolvePy(from: string, spec: { mod: string; names: string[] }, known: Set<string>): string[] {
  const root = 'ingestor/'
  let pkgPath: string
  if (spec.mod.startsWith('.')) {
    const dots = /^\.+/.exec(spec.mod)![0].length
    let dir = path.posix.dirname(from)
    for (let k = 1; k < dots; k++) dir = path.posix.dirname(dir)
    const rest = spec.mod.slice(dots).replace(/\./g, '/')
    pkgPath = rest ? `${dir}/${rest}` : dir
  } else pkgPath = root + spec.mod.replace(/\./g, '/')
  const hits: string[] = []
  if (known.has(`${pkgPath}.py`)) hits.push(`${pkgPath}.py`)
  else {
    for (const n of spec.names) if (known.has(`${pkgPath}/${n}.py`)) hits.push(`${pkgPath}/${n}.py`)
    if (!hits.length && known.has(`${pkgPath}/__init__.py`)) hits.push(`${pkgPath}/__init__.py`)
  }
  return hits
}

// ---------------------------------------------------------------- docs

const rControl = /[\u0000-\u001f]/g
const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[̀-ͯ]/g
/** Same algorithm VitePress uses for heading ids. */
const slugify = (str: string) =>
  str.normalize('NFKD').replace(rCombining, '').replace(rControl, '').replace(rSpecial, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, '_$1').toLowerCase()

interface DocPage {
  page: string
  title: string
  lines: { text: string; section: string | null; anchor: string | null }[]
}

function loadDocs(): DocPage[] {
  const root = path.join(DOCS_SITE, 'docs')
  const out: DocPage[] = []
  const walkDocs = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      const f = path.join(dir, e)
      if (statSync(f).isDirectory()) {
        if (!e.startsWith('.') && e !== 'public') walkDocs(f)
        continue
      }
      if (!e.endsWith('.md')) continue
      const rel = path.relative(root, f).split(path.sep).join('/')
      if (rel === 'reference/code-map.md') continue
      const src = readFileSync(f, 'utf8')
      const title = /^---[\s\S]*?^title:\s*(.+)$[\s\S]*?^---/m.exec(src)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? rel
      const page = '/' + rel.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
      const seen = new Map<string, number>()
      let section: string | null = null
      let anchor: string | null = null
      let fence = false
      const lines: DocPage['lines'] = []
      for (const line of src.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence
        const h = !fence && /^(#{2,4})\s+(.+?)\s*$/.exec(line)
        if (h) {
          let text = h[2]
          const custom = /\s*\{#([\w-]+)\}\s*$/.exec(text)
          text = text.replace(/\s*\{#[\w-]+\}\s*$/, '')
          const plain = text
            .replace(/<[^>]+>/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/[`*_]/g, m => (m === '_' ? '_' : ''))
            .trim()
          let id = custom ? custom[1] : slugify(plain)
          if (!custom) {
            const n = seen.get(id) ?? 0
            seen.set(id, n + 1)
            if (n) id = `${id}-${n}`
          }
          section = plain
          anchor = id
        }
        lines.push({ text: line, section, anchor })
      }
      out.push({ page, title, lines })
    }
  }
  if (existsSync(root)) walkDocs(root)
  return out
}

// ---------------------------------------------------------------- main

export function generateCodeMap() {
  const { files, tests, ingestor } = listFiles()
  const known = new Set(files)
  const overridesFile = path.join(DATA_DIR, 'code-map-overrides.json')
  const ov: { fallback?: Record<string, string>; replace?: Record<string, string> } = existsSync(overridesFile)
    ? JSON.parse(readFileSync(overridesFile, 'utf8'))
    : {}
  const overrides = ov.fallback ?? {}
  const replacements = ov.replace ?? {}

  const srcCache = new Map<string, string>()
  const src = (p: string) => {
    let s = srcCache.get(p)
    if (s === undefined) srcCache.set(p, (s = readSrc(p)))
    return s
  }

  const entries: Entry[] = files.map(p => {
    const s = src(p)
    const kind = classify(p, s)
    const isJs = /\.([cm]?[jt]sx?)$/.test(p)
    const isPy = p.endsWith('.py')
    const exportsList = isJs ? jsExports(s) : isPy ? pyExports(s) : []
    let purpose: string | null = null
    let purposeSource: Source | null = null
    const main = isJs ? mainExportLines(s, p) : new Set<number>()
    const header = isJs
      ? jsHeader(s, p, main)
      : isPy
        ? pyHeader(s, p)
        : p.endsWith('.sql')
          ? sqlHeader(s, p)
          : p.endsWith('.css')
            ? cssHeader(s, p)
            : /\.(sh|ya?ml|toml|txt|service|timer)$|(^|\/)Dockerfile[^/]*$/.test(p)
              ? hashHeader(s, p)
              : null
    if (header) [purpose, purposeSource] = [header, 'header']
    if (!purpose) {
      const doc = isJs ? jsExportDoc(s, p, main) : isPy ? pyExportDoc(s, p) : null
      if (doc) [purpose, purposeSource] = [doc, 'jsdoc']
    }
    if (!purpose) {
      const d = derived(p, s, kind)
      if (d) [purpose, purposeSource] = [d, 'derived']
    }
    if (!purpose && overrides[p]) [purpose, purposeSource] = [clamp(overrides[p]), 'override']
    // `replace` wins over everything: for files whose header comment exists
    // but doesn't describe the file (boilerplate, a lint note, …).
    if (replacements[p]) [purpose, purposeSource] = [clamp(replacements[p]), 'override']
    return {
      path: p,
      dir: path.posix.dirname(p),
      area: areaOf(p),
      project: projectOf(p).project,
      kind,
      purpose: purpose ? scrub(purpose) : '',
      purposeSource,
      exports: exportsList,
      methods: kind === 'route-handler' ? methodsOf(s) : [],
      route: routeOf(p),
      usedBy: [],
      tests: [],
      docs: []
    }
  })
  const byPath = new Map(entries.map(e => [e.path, e]))

  // Reverse import edges.
  const addEdge = (from: string, to: string, bucket: 'usedBy' | 'tests') => {
    const e = byPath.get(to)
    if (e && from !== to && !e[bucket].includes(from)) e[bucket].push(from)
  }
  for (const p of [...files, ...tests]) {
    const bucket = isTestFile(p) ? 'tests' : 'usedBy'
    let s: string
    try {
      s = src(p)
    } catch {
      continue
    }
    if (/\.([cm]?[jt]sx?)$/.test(p)) {
      for (const spec of jsSpecifiers(s)) {
        const to = resolveJs(p, spec, known)
        if (to) addEdge(p, to, bucket)
      }
    } else if (p.endsWith('.py') && p.startsWith('ingestor/')) {
      for (const spec of pySpecifiers(s)) for (const to of resolvePy(p, spec, known)) addEdge(p, to, bucket)
    }
  }
  // Non-importable files (scripts, units, compose, Dockerfiles, migrations):
  // "used by" = other mapped files that name them.
  const basenameCount = new Map<string, number>()
  for (const p of files) basenameCount.set(path.posix.basename(p), (basenameCount.get(path.posix.basename(p)) ?? 0) + 1)
  const refKinds = new Set(['script', 'ops-script', 'systemd-unit', 'dockerfile', 'compose', 'config', 'test-helper', 'data', 'migration'])
  const textFiles = files.filter(p => !/\.json$/.test(p) || /package\.json$/.test(p))
  for (const e of entries) {
    if (!refKinds.has(e.kind)) continue
    const base = path.posix.basename(e.path)
    const inner = projectOf(e.path).inner
    const needles = [inner]
    if (basenameCount.get(base) === 1 && base.length > 6 && !/^(package|tsconfig)\.json$|^Dockerfile$/.test(base)) needles.push(base)
    const res = needles.map(n => new RegExp(`(^|[^\\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`))
    for (const other of textFiles) {
      if (other === e.path || projectOf(other).project !== e.project) continue
      if (res.some(re => re.test(src(other)))) addEdge(other, e.path, 'usedBy')
    }
  }
  for (const e of entries) {
    e.usedBy.sort()
    e.tests.sort()
  }

  // Docs pages that mention each file (full path anywhere; unique basename as a word).
  const docs = loadDocs()
  for (const e of entries) {
    const inner = projectOf(e.path).inner
    const base = path.posix.basename(e.path)
    const needles = new Set([e.path])
    if (e.project === 'ask') needles.add(inner)
    else if (e.project === 'model-manager') needles.add(`model-manager/${inner}`)
    const generic = /^(index|route|page|layout|utils|types|config|schema|constants|client|server|auth|lock|diff|exec|apply)\.(ts|tsx|py)$|^(Dockerfile|package\.json|tsconfig\.json|__init__\.py|requirements\.txt|docker-compose\.yaml|globals\.css)$/
    const baseRe =
      basenameCount.get(base) === 1 && !generic.test(base)
        ? new RegExp(`(^|[^\\w/.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
        : null
    for (const d of docs) {
      const hit = d.lines.find(l => [...needles].some(n => l.text.includes(n)) || (baseRe && baseRe.test(l.text)))
      if (hit) e.docs.push({ page: d.page, title: d.title, section: hit.section, anchor: hit.anchor })
    }
  }

  const missing = entries.filter(e => !e.purpose).map(e => e.path)
  const bySource = (s: Source) => entries.filter(e => e.purposeSource === s).length
  const staleOverrides = [...Object.keys(overrides), ...Object.keys(replacements)].filter(k => !byPath.has(k))
  const shadowedOverrides = Object.keys(overrides).filter(k => byPath.has(k) && byPath.get(k)!.purposeSource !== 'override' && !replacements[k])
  const kinds: Record<string, number> = {}
  for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1

  return {
    data: {
      generatedFrom: { ask: path.basename(REPO), ingestor: ingestor ? 'ingestor' : null },
      count: entries.length,
      coverage: {
        files: entries.length,
        withPurpose: entries.length - missing.length,
        header: bySource('header'),
        jsdoc: bySource('jsdoc'),
        derived: bySource('derived'),
        override: bySource('override'),
        documented: entries.filter(e => e.docs.length).length
      },
      kinds,
      files: entries
    },
    missing,
    staleOverrides,
    shadowedOverrides
  }
}

if (import.meta.main) {
  const t0 = performance.now()
  const { data, missing, staleOverrides, shadowedOverrides } = generateCodeMap()
  writeJson('code-map.json', data)
  const c = data.coverage
  console.log(
    `[code-map] coverage: ${c.files} files, ${c.withPurpose} with purposes ` +
      `(header ${c.header}, jsdoc ${c.jsdoc}, derived ${c.derived}, overrides ${c.override}), ` +
      `${c.documented} mentioned in docs (${Math.round(performance.now() - t0)}ms)`
  )
  if (staleOverrides.length) console.warn(`[code-map] ${staleOverrides.length} override(s) for files no longer mapped:\n  ${staleOverrides.join('\n  ')}`)
  if (shadowedOverrides.length && process.env.CODE_MAP_VERBOSE) console.warn(`[code-map] overrides unused (file has its own comment):\n  ${shadowedOverrides.join('\n  ')}`)
  if (missing.length) {
    console.error(
      `[code-map] ${missing.length} file(s) have no purpose. Add a header comment to the file, ` +
        `or a one-liner to docs-site/data/code-map-overrides.json:\n  ${missing.join('\n  ')}`
    )
    process.exit(1)
  }
}
