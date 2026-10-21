import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const path = resolve(__dirname, '../sync-mac.sh')
const script = readFileSync(path, 'utf8')

/** The body of the shell function `name`, up to its closing brace. */
function body(name: string): string {
  const match = script.match(
    new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, 'm')
  )
  if (!match) throw new Error(`no function ${name} in sync-mac.sh`)
  return match[1]
}

// An auto-sending build (ask:// links send at once, the seeded e2e-ask
// question is asked at launch) is for the simulator E2E only: on a device a
// link from any app could send a turn, and a turn can write a lasting memory.
describe('sync-mac.sh', () => {
  it('is valid bash', () => {
    expect(() => execFileSync('bash', ['-n', path])).not.toThrow()
  })

  it('sets VITE_E2E_AUTOSEND on every build, true only for e2e', () => {
    const build = body('build_local')
    expect(build).toMatch(/autosend=false/)
    expect(build).toMatch(/if \[ "\$\{1:-\}" = e2e \]; then autosend=true; fi/)
    expect(build).toMatch(/VITE_E2E_AUTOSEND="\$autosend" npm run build/)
  })

  it('builds the auto-sending bundle for the simulator run only', () => {
    expect(body('sync_up')).toMatch(/build_local "\$\{1:-\}"/)
    expect(body('sim')).toMatch(/^\s*sync_up e2e$/m)
    // The only e2e build; sync and the device install build plainly.
    expect(script.match(/sync_up e2e/g)).toHaveLength(1)
    expect(script).toMatch(/^\s*sync\) sync_up ;;$/m)
    expect(script).toMatch(/^\s*all\) sync_up; build_install ;;$/m)
  })
})
