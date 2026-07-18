export function parseList(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(Boolean)
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
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items
  }
  const next = [...items]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}
