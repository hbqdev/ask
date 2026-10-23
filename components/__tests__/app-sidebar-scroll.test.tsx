import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

// The sidebar's middle area must not scroll as a whole: Home / Discover /
// Library stay put and only the Recent list scrolls (RecentChatsSection owns
// its own scroller). Asserted on the source because AppSidebar needs the
// full app shell to render.
const source = readFileSync(
  path.join(__dirname, '..', 'app-sidebar.tsx'),
  'utf8'
)

describe('AppSidebar scrolling', () => {
  test('the content area does not scroll as a whole', () => {
    expect(source).toMatch(
      /<SidebarContent className="[^"]*\boverflow-hidden\b/
    )
  })

  test('the nav rows keep their size', () => {
    const navs = source.match(/<nav className="[^"]*"/g) ?? []
    expect(navs).toHaveLength(2)
    for (const nav of navs) expect(nav).toMatch(/\bshrink-0\b/)
  })
})
