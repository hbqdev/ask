import { describe, expect, it } from 'vitest'

import { isCitationLabel } from '@ask/utils/citation'
import { displayUrlName } from '@ask/utils/domain'

// `@ask/` reuses Ask's pure modules from the repo's lib/. Those modules import
// each other as `@/lib/...` (Ask's root alias), which must still reach lib/
// here even though this app's own `@/` means src/.
describe('path aliases', () => {
  it('resolves an Ask lib module through @ask/', () => {
    expect(displayUrlName('https://www.example.com/page')).toBe('example')
  })

  it("resolves an Ask lib module whose own imports use Ask's @/lib/", () => {
    expect(isCitationLabel('search-1')).toBe(true)
  })
})
