// Pure helpers for the Discover route's mixed, multi-category home-widget feed
// (app/api/discover/route.ts). Kept separate from the route so they can be unit
// tested without the route's network fan-out.

export interface RankableItem {
  title?: string
  url?: string
  thumbnail?: string
}

// A Discover result is only usable in a widget/grid that renders an image, so
// it must carry a thumbnail and a real title. The >= 20 char title guard
// mirrors the one the discover route already applies to drop stub/nav results.
export function isDisplayable(item: RankableItem): boolean {
  return Boolean(
    item.thumbnail &&
      item.thumbnail.trim() &&
      item.title &&
      item.title.trim().length >= 20
  )
}

// Drop items whose (case-insensitive) URL was already seen, preserving order.
// Guards the rare case where two categories surface the same syndicated wire
// story, so the mixed feed never shows the same article twice.
export function dedupeByUrl<T extends { url?: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const url = item.url?.toLowerCase().trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(item)
  }
  return out
}

// Fisher–Yates shuffle. `rng` is injectable so tests are deterministic; it
// defaults to Math.random in production.
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
