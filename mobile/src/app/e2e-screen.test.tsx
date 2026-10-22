import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Tabs, type TabSpec } from '@/app/Tabs'
import type { AuthStorage } from '@/core/auth/preferences-storage'
import { E2E_SCREEN_KEY, parseE2eScreen, useE2eScreen } from '@/app/e2e-screen'
import { StackProvider, useStack } from '@/core/nav/stack'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

const settle = () => act(async () => {})

const TABS: TabSpec[] = [
  { id: 'ask', label: 'Ask', icon: <svg />, render: () => <p>Ask home</p> },
  {
    id: 'discover',
    label: 'Discover',
    icon: <svg />,
    render: () => <p>Discover page</p>
  },
  {
    id: 'library',
    label: 'Library',
    icon: <svg />,
    render: () => <p>Library page</p>
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: <svg />,
    render: () => <p>Settings page</p>
  }
]

/** The stack's screen keys at the last render. */
let stackKeys: string[] = []

function Probe(props: { enabled?: boolean; storage?: AuthStorage }) {
  useE2eScreen(props)
  stackKeys = useStack().screens.map(s => s.key)
  return null
}

/** The hook mounted the way the app mounts it: inside the stacked tab shell. */
function renderShell(props: { enabled?: boolean; storage?: AuthStorage }) {
  return render(
    <StackProvider root={{ key: 'tabs', render: () => null }}>
      <Tabs tabs={TABS}>
        <Probe {...props} />
      </Tabs>
    </StackProvider>
  )
}

function selectedTab() {
  return screen
    .getAllByRole('tab')
    .find(t => t.getAttribute('aria-selected') === 'true')?.textContent
}

describe('parseE2eScreen', () => {
  it.each(['ask', 'discover', 'library', 'settings', 'settings/memory'])(
    'accepts %s',
    value => {
      expect(parseE2eScreen(value)).toBe(value)
    }
  )

  it('trims the value', () => {
    expect(parseE2eScreen('  library \n')).toBe('library')
  })

  it.each(['', 'home', 'Settings', 'settings/', 'library/memory', 'toString'])(
    'rejects %j',
    value => {
      expect(parseE2eScreen(value)).toBeNull()
    }
  )
})

describe('useE2eScreen', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the Preferences key "e2e-screen"', () => {
    expect(E2E_SCREEN_KEY).toBe('e2e-screen')
  })

  it.each([
    ['discover', 'Discover'],
    ['library', 'Library'],
    ['settings', 'Settings']
  ])('opens the %s tab and consumes the key', async (value, label) => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: value })
    renderShell({ enabled: true, storage })
    await settle()

    expect(selectedTab()).toBe(label)
    expect(storage.data.has(E2E_SCREEN_KEY)).toBe(false)
  })

  it('stays on Ask for "ask"', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'ask' })
    renderShell({ enabled: true, storage })
    await settle()

    expect(selectedTab()).toBe('Ask')
    expect(storage.data.has(E2E_SCREEN_KEY)).toBe(false)
  })

  it('removes the key before switching tabs', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'library' })
    let tabWhenRemoved: string | undefined
    storage.removeItem.mockImplementation(async (key: string) => {
      tabWhenRemoved = selectedTab()
      storage.data.delete(key)
    })
    renderShell({ enabled: true, storage })
    await settle()

    expect(tabWhenRemoved).toBe('Ask')
    expect(selectedTab()).toBe('Library')
  })

  it('runs once per launch', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'library' })
    const { rerender } = renderShell({ enabled: true, storage })
    await settle()
    rerender(
      <StackProvider root={{ key: 'tabs', render: () => null }}>
        <Tabs tabs={TABS}>
          <Probe enabled storage={storage} />
        </Tabs>
      </StackProvider>
    )
    await settle()

    expect(storage.getItem).toHaveBeenCalledOnce()
    expect(storage.removeItem).toHaveBeenCalledOnce()
  })

  it('never reads the key when the build is not an E2E build', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'library' })
    renderShell({ storage })
    await settle()

    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(storage.data.get(E2E_SCREEN_KEY)).toBe('library')
    expect(selectedTab()).toBe('Ask')
  })

  it('is on in a VITE_E2E_AUTOSEND build', async () => {
    vi.stubEnv('VITE_E2E_AUTOSEND', 'true')
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'settings' })
    renderShell({ storage })
    await settle()

    expect(selectedTab()).toBe('Settings')
  })

  it('ignores an unknown value, still consuming it', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'nowhere' })
    renderShell({ enabled: true, storage })
    await settle()

    expect(selectedTab()).toBe('Ask')
    expect(storage.data.has(E2E_SCREEN_KEY)).toBe(false)
  })

  it('opens Settings, then the Memory screen, for "settings/memory"', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'settings/memory' })
    renderShell({ enabled: true, storage })
    await settle()

    expect(selectedTab()).toBe('Settings')
    expect(stackKeys).toEqual(['tabs', 'settings:memory'])
    expect(storage.data.has(E2E_SCREEN_KEY)).toBe(false)
  })

  it('pushes nothing for a tab', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'settings' })
    renderShell({ enabled: true, storage })
    await settle()

    expect(stackKeys).toEqual(['tabs'])
  })

  it('does nothing when the key is missing', async () => {
    const storage = memoryStorage()
    renderShell({ enabled: true, storage })
    await settle()

    expect(storage.getItem).toHaveBeenCalledWith(E2E_SCREEN_KEY)
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(selectedTab()).toBe('Ask')
  })

  it('logs a storage failure instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'library' })
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    renderShell({ enabled: true, storage })
    await settle()

    expect(warn).toHaveBeenCalledWith(
      '[e2e] could not open the seeded screen',
      expect.any(Error)
    )
    expect(selectedTab()).toBe('Ask')
    warn.mockRestore()
  })

  it('consumes the key without throwing outside the tab shell', async () => {
    const storage = memoryStorage({ [E2E_SCREEN_KEY]: 'library' })
    renderHook(() => useE2eScreen({ enabled: true, storage }), {
      wrapper: ({ children }) => (
        <StackProvider root={{ key: 'root', render: () => null }}>
          {children}
        </StackProvider>
      )
    })
    await settle()

    expect(storage.data.has(E2E_SCREEN_KEY)).toBe(false)
  })

  it('reads Capacitor Preferences by default', async () => {
    const { Preferences } = await import('@capacitor/preferences')
    renderShell({ enabled: true })
    await settle()
    expect(Preferences.get).toHaveBeenCalledWith({ key: E2E_SCREEN_KEY })
  })
})
