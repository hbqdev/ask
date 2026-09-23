// Shared helpers for the docs-site generators.
// The generators read the Ask repo at `..` relative to docs-site, so every
// branch/worktree documents ITSELF. They never read real `.env` files.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

export const DOCS_SITE = path.resolve(import.meta.dir, '..', '..')
export const REPO = path.resolve(DOCS_SITE, '..')
export const DATA_DIR = path.join(DOCS_SITE, 'data')

/** Variable names whose VALUES must never be emitted. */
export const SECRET_NAME_RE =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|DSN|DATABASE_URL|DATABASE_\w*URL|CREDENTIAL|AUTH_HEADER|COOKIE|SESSION_SECRET/i
export const SECRET_PLACEHOLDER = '(secret — not shown)'

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name)
}

/**
 * A value is safe to emit only if its name is not secret-shaped AND the value
 * itself doesn't look like it carries credentials (user:pass@ in a URL,
 * long high-entropy tokens, PEM blocks).
 */
export function isSafeValue(name: string, value: string): boolean {
  if (isSecretName(name)) return false
  if (/:\/\/[^/\s]*@/.test(value)) return false // scheme://user:pass@host
  if (/-----BEGIN/.test(value)) return false
  if (/^(sk|pk|rk|ghp|gho|xox[abp]|eyJ)[-_A-Za-z0-9.]{16,}$/.test(value)) return false
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(value)) return false // long opaque token
  return true
}

export function redactValue(name: string, value: string): string {
  return isSafeValue(name, value) ? value : SECRET_PLACEHOLDER
}

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.claude', '.superpowers', 'docs-site',
  'selfhosted', 'coverage', 'dist', 'out', 'build'
])

/** Recursively list files under `dir` (repo-relative paths, sorted). */
export function walk(dir: string, filter: (rel: string) => boolean): string[] {
  const out: string[] = []
  const abs = path.join(REPO, dir)
  let entries: string[]
  try {
    entries = readdirSync(abs)
  } catch {
    return out
  }
  for (const e of entries.sort()) {
    if (SKIP_DIRS.has(e)) continue
    const rel = path.posix.join(dir, e)
    const st = statSync(path.join(REPO, rel))
    if (st.isDirectory()) out.push(...walk(rel, filter))
    else if (filter(rel)) out.push(rel)
  }
  return out
}

export function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), 'utf8')
}

/** Root-level files in the repo matching a regex (sorted). */
export function rootFiles(re: RegExp): string[] {
  return readdirSync(REPO)
    .filter(f => re.test(f) && statSync(path.join(REPO, f)).isFile())
    .sort()
}

/** Never let a real env file be read by a generator. */
export function isRealEnvFile(rel: string): boolean {
  const base = path.basename(rel)
  return /^\.env/.test(base) && !/example/i.test(base)
}

export function writeJson(name: string, data: unknown): string {
  mkdirSync(DATA_DIR, { recursive: true })
  const file = path.join(DATA_DIR, name)
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return file
}

/** Parse a compose file; strips compose-only YAML tags (!override, !reset). */
export function parseCompose(text: string): any {
  return parse(text.replace(/:\s*!(override|reset)\b/g, ':'))
}
