// `bun run check` (after `vitepress build`): fail on dead internal links.
//  1. Every internal href in the built HTML must resolve to a page/asset, and
//     its #anchor (if any) must exist as an id on that page.
//  2. Every `link` in data/system-map.json and data/turn-steps.json must too.
//  3. Code references (`code: ["path:line"]`) in turn-steps.json must exist in
//     the repo (warning only — line numbers drift).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SITE = path.resolve(import.meta.dir, '..')
const DIST = path.join(SITE, '.vitepress', 'dist')
const REPO = path.resolve(SITE, '..')

if (!existsSync(DIST)) {
  console.error('No build output — run `bun run docs:build` first.')
  process.exit(2)
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(e => {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) return e === 'assets' ? [] : htmlFiles(p)
    return e.endsWith('.html') ? [p] : []
  })
}

const idCache = new Map<string, Set<string>>()
function ids(file: string): Set<string> {
  let s = idCache.get(file)
  if (!s) {
    s = new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map(m => decodeHtml(m[1])))
    idCache.set(file, s)
  }
  return s
}
function decodeHtml(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** Resolve a site-absolute URL path to a file in dist, or null. */
function resolvePage(urlPath: string): string | null {
  const p = decodeURIComponent(urlPath).replace(/\/+$/, '') || '/'
  const candidates =
    p === '/'
      ? ['index.html']
      : [p.slice(1) + '.html', path.join(p.slice(1), 'index.html'), p.slice(1)]
  for (const c of candidates) {
    const f = path.join(DIST, c)
    if (existsSync(f) && statSync(f).isFile()) return f
  }
  return null
}

const errors: string[] = []
const warnings: string[] = []

function checkLink(href: string, fromUrl: string, where: string) {
  if (/^(https?:|mailto:|tel:|javascript:|data:)/i.test(href) || href.startsWith('//')) return
  const [rawPath, anchor] = href.split('#')
  let target: string
  if (!rawPath) target = fromUrl
  else if (rawPath.startsWith('/')) target = rawPath
  else target = path.posix.resolve(path.posix.dirname(fromUrl + '_'), rawPath)
  target = target.split('?')[0]
  const file = resolvePage(target)
  if (!file) {
    errors.push(`${where}: dead link → ${href}`)
    return
  }
  if (anchor && file.endsWith('.html') && !ids(file).has(decodeURIComponent(anchor))) {
    errors.push(`${where}: missing anchor #${anchor} on ${target}`)
  }
}

// 1. Built HTML.
let linkCount = 0
for (const file of htmlFiles(DIST)) {
  const rel = path.relative(DIST, file)
  if (rel === '404.html') continue
  const url = '/' + rel.replace(/(index)?\.html$/, '')
  const html = readFileSync(file, 'utf8')
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const href = decodeHtml(m[1])
    if (href.startsWith('/assets/') || href.startsWith('/vp-icons')) continue
    linkCount++
    checkLink(href, url, rel)
  }
}

// 2 + 3. Data files rendered client-side.
const dataLinks: [string, string][] = []
try {
  const map = JSON.parse(readFileSync(path.join(SITE, 'data/system-map.json'), 'utf8'))
  for (const n of map.nodes ?? []) if (n.link) dataLinks.push([`system-map.json node ${n.id}`, n.link])
  const ids = new Set((map.nodes ?? []).map((n: any) => n.id))
  for (const e of map.edges ?? []) {
    for (const end of [e.from, e.to]) if (!ids.has(end)) errors.push(`system-map.json: edge references unknown node "${end}"`)
  }
  for (const n of map.nodes ?? []) if (n.host && !ids.has(n.host)) errors.push(`system-map.json: node ${n.id} has unknown host "${n.host}"`)
} catch (e) {
  errors.push(`system-map.json unreadable: ${e}`)
}
try {
  const steps = JSON.parse(readFileSync(path.join(SITE, 'data/turn-steps.json'), 'utf8'))
  for (const s of steps) {
    if (s.link) dataLinks.push([`turn-steps.json step ${s.id}`, s.link])
    for (const c of s.code ?? []) {
      const [p, line] = String(c).split(':')
      const f = path.join(REPO, p)
      if (!existsSync(f)) warnings.push(`turn-steps.json step ${s.id}: code path not found: ${c}`)
      else if (line && statSync(f).isFile()) {
        const n = readFileSync(f, 'utf8').split('\n').length
        if (+line > n) warnings.push(`turn-steps.json step ${s.id}: ${c} is past end of file (${n} lines)`)
      }
    }
  }
} catch (e) {
  errors.push(`turn-steps.json unreadable: ${e}`)
}
for (const [where, link] of dataLinks) checkLink(link, '/', where)

for (const w of warnings) console.warn('warn  ' + w)
for (const e of errors) console.error('ERROR ' + e)
console.log(
  `[check] ${linkCount} internal links in HTML + ${dataLinks.length} data links: ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`
)
process.exit(errors.length ? 1 : 0)
