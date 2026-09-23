// api-routes.json — every Next.js route handler (app/**/route.ts).
import { existsSync } from 'node:fs'
import path from 'node:path'

import { read, REPO, walk } from './lib'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const AUTH_DETECTORS: [string, RegExp, string][] = [
  ['user-session', /\bgetCurrentUser(Id)?\s*\(/, 'Supabase session (or ANONYMOUS_USER_ID when ENABLE_AUTH=false) via lib/auth/get-current-user.ts'],
  ['ingest-token', /\bcheckIngestAuth\s*\(/, 'Bearer INGEST_API_TOKEN (service-to-service)'],
  ['cron-secret', /\brequireCronSecret\s*\(/, 'Bearer MEMORY_CRON_SECRET (scheduled jobs)'],
  ['signed-url', /\bverifyUploadSignature\s*\(/, 'HMAC-signed capability URL (UPLOADS_URL_SECRET)'],
  ['supabase-otp', /\bverifyOtp\s*\(|exchangeCodeForSession\s*\(/, 'Supabase auth callback (OTP / OAuth code exchange)']
]

function routePath(file: string): string {
  const p = file
    .replace(/^app/, '')
    .replace(/\/route\.ts$/, '')
    .split('/')
    .filter(seg => !/^\(.*\)$/.test(seg)) // route groups
    .map(seg =>
      seg
        .replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*?')
        .replace(/^\[\.\.\.(.+)\]$/, ':$1*')
        .replace(/^\[(.+)\]$/, ':$1')
    )
    .join('/')
  return p || '/'
}

/** Resolve `@/lib/x` imports to repo files (one level; for indirect auth). */
function importedModules(src: string): string[] {
  const out: string[] = []
  const re = /import\s+[^'"]*?from\s+['"]@\/([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    for (const cand of [`${m[1]}.ts`, `${m[1]}.tsx`, `${m[1]}/index.ts`]) {
      if (existsSync(path.join(REPO, cand))) {
        out.push(cand)
        break
      }
    }
  }
  return out
}

function summary(src: string): string | null {
  // The route's description = the first comment block in the file preamble
  // that is followed by a blank line or an export (a block directly above a
  // `const` documents that constant, not the route).
  const lines = src.split('\n').map(l => l.trim())
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line || /^(import\b|['"]use |from\s|\}|[\w{},\s]+,?$)/.test(line)) { i++; continue }
    if (!(line.startsWith('//') || line.startsWith('/*'))) return null
    const buf: string[] = []
    if (line.startsWith('//')) {
      while (i < lines.length && lines[i].startsWith('//')) buf.push(lines[i++].replace(/^\/\/\s?/, ''))
    } else {
      let first = true
      while (i < lines.length) {
        const l = lines[i++]
        const done = l.includes('*/')
        const t = l.replace(first ? /^\/\*+\s?/ : /^\*\s?/, '').replace(/\*\/\s*$/, '').trim()
        first = false
        if (t) buf.push(t)
        if (done) break
      }
    }
    const next = lines[i] ?? ''
    if (next && !/^(import\b|export\s+(default|(async\s+)?function|const\s+(dynamic|runtime|revalidate)\b))/.test(next)) {
      continue // a comment attached to some other declaration; keep looking only if it's still preamble
    }
    const text = buf.join(' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text
    return sentence.length > 220 ? sentence.slice(0, 217) + '…' : sentence
  }
  return null
}

export function generateApiRoutes() {
  const files = walk('app', f => /\/route\.(ts|js)$/.test(f))
  const routes = files.map(file => {
    const src = read(file)
    const methods = METHODS.filter(m =>
      new RegExp(`export\\s+(async\\s+)?(function\\s+${m}\\b|const\\s+${m}\\b)|export\\s*\\{[^}]*\\b${m}\\b`).test(src)
    )
    const auth = AUTH_DETECTORS.filter(([, re]) => re.test(src)).map(([id]) => id)
    const authVia: string[] = []
    if (!auth.length) {
      // Indirect: the handler delegates to a server action / helper that
      // performs the session check itself.
      for (const mod of importedModules(src)) {
        const msrc = read(mod)
        for (const [id, re] of AUTH_DETECTORS) {
          if (re.test(msrc)) {
            if (!auth.includes(id)) auth.push(id)
            authVia.push(mod)
          }
        }
      }
    }
    return {
      path: routePath(file),
      methods,
      auth: auth.length ? auth : ['public'],
      authVia: [...new Set(authVia)],
      guestAllowed: auth.includes('user-session') && /isGuest|guest/i.test(src),
      summary: summary(src),
      file,
      dynamic: /export const dynamic\s*=\s*'([^']+)'/.exec(src)?.[1] ?? null
    }
  })
  routes.sort((a, b) => a.path.localeCompare(b.path))
  return {
    authMechanisms: Object.fromEntries(
      [...AUTH_DETECTORS.map(([id, , d]) => [id, d]), ['public', 'No auth check detected in the handler file (may still be gated by a feature flag or proxy.ts).']]
    ),
    count: routes.length,
    routes
  }
}
