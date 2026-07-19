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
