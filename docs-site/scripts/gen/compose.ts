// compose-services.json — every docker-compose*.yaml (base + overlays):
// services, image/build, ports, networks, restart, depends_on and env KEYS.


import { parseCompose, read, redactValue, rootFiles } from './lib'

export function composeFiles(): string[] {
  return rootFiles(/^docker-compose.*\.ya?ml$/)
}

function envLabel(file: string): string {
  const m = /^docker-compose\.?(.*)\.ya?ml$/.exec(file)
  const s = m?.[1] ?? ''
  if (!s) return 'prod (base)'
  if (s === 'vpn') return 'prod VPN overlay'
  if (s === 'lab') return 'lab overlay'
  if (s === 'vpn.lab') return 'lab VPN overlay'
  if (s === 'admin-feature') return 'staging overlay'
  if (s === 'vpn.admin-feature') return 'staging VPN overlay'
  return s
}

function list(v: unknown): string[] {
  if (!v) return []
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x)))
  if (typeof v === 'object') return Object.keys(v as object)
  return [String(v)]
}

/** Keys marked `!override` / `!reset` per service (they REPLACE, not merge). */
function overrideKeys(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let inServices = false
  let svc: string | null = null
  for (const line of text.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue }
    if (/^\S/.test(line)) { inServices = false; svc = null; continue }
    if (!inServices) continue
    const sm = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (sm) { svc = sm[1]; continue }
    const km = /^    ([A-Za-z_]+):\s*!(override|reset)\b/.exec(line)
    if (km && svc) (out[svc] ??= []).push(km[1])
  }
  return out
}

export const ENVIRONMENTS = [
  { id: 'prod', label: 'Prod', project: 'ask-stack', files: ['docker-compose.yaml', 'docker-compose.vpn.yaml'] },
  { id: 'staging', label: 'Staging', project: 'ask-stack-admin-feature', files: ['docker-compose.yaml', 'docker-compose.admin-feature.yaml', 'docker-compose.vpn.yaml', 'docker-compose.vpn.admin-feature.yaml'] },
  { id: 'lab', label: 'Lab', project: 'ask-stack-lab', files: ['docker-compose.yaml', 'docker-compose.lab.yaml', 'docker-compose.vpn.lab.yaml'] }
]

export function generateCompose() {
  const files = composeFiles().map(file => {
    const text = read(file)
    const doc = parseCompose(text)
    const overrides = overrideKeys(text)
    const services = Object.entries(doc?.services ?? {}).map(([name, s]: [string, any]) => {
      const env = s?.environment
      const pairs: [string, string | undefined][] = Array.isArray(env)
        ? env.map((e: string) => {
            const [k, ...v] = String(e).split('=')
            return [k, v.length ? v.join('=') : undefined]
          })
        : Object.entries(env ?? {}).map(([k, v]) => [k, v == null ? undefined : String(v)])
      return {
        name,
        containerName: s?.container_name ?? null,
        image: s?.image ?? null,
        build: s?.build
          ? typeof s.build === 'string'
            ? { context: s.build }
            : { context: s.build.context ?? '.', dockerfile: s.build.dockerfile ?? null }
          : null,
        ports: list(s?.ports),
        expose: list(s?.expose),
        networks: list(s?.networks),
        networkMode: s?.network_mode ?? null,
        restart: s?.restart ?? null,
        dependsOn: list(s?.depends_on),
        envFile: list(s?.env_file),
        volumes: list(s?.volumes),
        profiles: list(s?.profiles),
        healthcheck: Boolean(s?.healthcheck),
        overrides: overrides[name] ?? [],
        env: pairs
          .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
          .map(([key, v]) => ({ key, value: v === undefined ? null : redactValue(key, v) }))
          .sort((a, b) => a.key.localeCompare(b.key))
      }
    })
    services.sort((a, b) => a.name.localeCompare(b.name))
    return {
      file,
      label: envLabel(file),
      projectName: doc?.name ?? null,
      networks: Object.entries(doc?.networks ?? {}).map(([n, d]: [string, any]) => ({
        name: n,
        external: Boolean(d?.external),
        externalName: d?.name ?? null
      })),
      volumes: Object.keys(doc?.volumes ?? {}),
      services
    }
  })
  return {
    note: 'Overlays MERGE onto the base file (environment is additive). Env values of secret-named keys, or values carrying credentials, are redacted. Real .env files are never read.',
    environments: ENVIRONMENTS.map(e => ({ ...e, files: e.files.filter(f => files.some(x => x.file === f)) })),
    files
  }
}
