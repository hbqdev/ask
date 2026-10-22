import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ActiveWithin,
  Tabs,
  useSelectTab,
  useTabActive,
  type TabSpec
} from '@/app/Tabs'
import { haptic } from '@/core/haptics'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

// Vitest does not process CSS, so read the stylesheet as text.
const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')

function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      Count {n}
    </button>
  )
}

function makeTabs(libraryRender = () => <p>Your library</p>): TabSpec[] {
  return [
    { id: 'ask', label: 'Ask', icon: <svg />, render: () => <Counter /> },
    { id: 'library', label: 'Library', icon: <svg />, render: libraryRender },
    {
      id: 'settings',
      label: 'Settings',
      icon: <svg />,
      render: () => <p>Settings page</p>
    }
  ]
}

function tab(name: string) {
  return screen.getByRole('tab', { name })
}

describe('Tabs', () => {
  it('starts on the first tab', () => {
    render(<Tabs tabs={makeTabs()} />)
    expect(tab('Ask')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Library')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel', { name: 'Ask' })).toBeVisible()
  })

  it('renders its children inside the shell, where useSelectTab works', () => {
    function GoToSettings() {
      const select = useSelectTab()
      return (
        <button type="button" onClick={() => select?.('settings')}>
          Go to settings
        </button>
      )
    }
    render(
      <Tabs tabs={makeTabs()}>
        <GoToSettings />
      </Tabs>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
  })

  it('starts on the initial tab when given', () => {
    render(<Tabs tabs={makeTabs()} initial="settings" />)
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Settings page')).toBeVisible()
  })

  it('switches tabs and keeps the others mounted with their state', () => {
    render(<Tabs tabs={makeTabs()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }))
    fireEvent.click(screen.getByRole('button', { name: 'Count 1' }))

    fireEvent.click(tab('Library'))
    expect(tab('Library')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Ask')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('Your library')).toBeVisible()
    // Ask is hidden but still mounted.
    const ask = screen.getByText('Count 2')
    expect(ask).not.toBeVisible()
    expect(ask.closest('[role="tabpanel"]')).toHaveAttribute('inert')

    fireEvent.click(tab('Ask'))
    expect(screen.getByRole('button', { name: 'Count 2' })).toBeVisible()
    expect(screen.getByText('Your library')).not.toBeVisible()
  })

  it('mounts a tab the first time it is opened, not before', () => {
    const libraryRender = vi.fn(() => <p>Your library</p>)
    render(<Tabs tabs={makeTabs(libraryRender)} />)
    expect(libraryRender).not.toHaveBeenCalled()
    expect(screen.queryByText('Your library')).not.toBeInTheDocument()
    expect(tab('Library')).not.toHaveAttribute('aria-controls')

    fireEvent.click(tab('Library'))
    expect(tab('Library')).toHaveAttribute(
      'aria-controls',
      screen.getByRole('tabpanel', { name: 'Library' }).id
    )
  })

  it('does not re-render a kept tab when switching', () => {
    const libraryRender = vi.fn(() => <p>Your library</p>)
    render(<Tabs tabs={makeTabs(libraryRender)} />)
    fireEvent.click(tab('Library'))
    fireEvent.click(tab('Ask'))
    fireEvent.click(tab('Library'))
    expect(libraryRender).toHaveBeenCalledTimes(1)
  })

  it('reselecting the active tab changes nothing', () => {
    render(<Tabs tabs={makeTabs()} />)
    fireEvent.click(tab('Ask'))
    expect(tab('Ask')).toHaveAttribute('aria-selected', 'true')
  })

  it("isolates each panel, so a tab's sticky or fixed layers stay inside it", () => {
    render(<Tabs tabs={makeTabs()} />)
    fireEvent.click(tab('Library'))
    for (const panel of screen.getAllByRole('tabpanel', { hidden: true })) {
      expect(panel).toHaveClass('isolate')
    }
  })

  it('pads the tab bar for the safe area', () => {
    render(<Tabs tabs={makeTabs()} />)
    expect(screen.getByRole('tablist')).toHaveClass('tab-bar')
    expect(css).toMatch(
      /\.tab-bar\s*{[^}]*padding-bottom:\s*max\(8px,\s*env\(safe-area-inset-bottom\)\)/
    )
  })

  it('labels follow the text size, capped at 13px so the bar keeps its height', () => {
    render(<Tabs tabs={makeTabs()} />)
    for (const name of ['Ask', 'Library', 'Settings']) {
      // 11px at the default 16px root; 13px from a 19px root up.
      expect(tab(name)).toHaveClass('text-[min(0.6875rem,13px)]')
      expect(tab(name).className).not.toContain('text-[11px]')
    }
  })
})

describe('navigation styles', () => {
  it('slides with a 280ms transform on the iOS curve', () => {
    expect(css).toContain('--nav-duration: 280ms')
    expect(css).toContain('--nav-ease: cubic-bezier(0.32, 0.72, 0, 1)')
    expect(css).toMatch(/@keyframes stack-in/)
    expect(css).toMatch(/\.stack-leave/)
  })

  it('makes every stack layer an opaque stacking context of its own', () => {
    const rule = css.match(/\n\.stack-layer\s*{([^}]*)}/)?.[1] ?? ''
    expect(rule).toMatch(/isolation:\s*isolate/)
    expect(rule).toMatch(/background-color:\s*var\(--background\)/)
  })

  it('drops the slides when the user asks for reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/)
  })
})

describe('useSelectTab', () => {
  function GoToSettings() {
    const selectTab = useSelectTab()
    return (
      <button type="button" onClick={() => selectTab?.('settings')}>
        Go to settings
      </button>
    )
  }

  it('lets a tab’s content switch tabs', () => {
    const tabs = makeTabs(() => <GoToSettings />)
    render(<Tabs tabs={tabs} initial="library" />)

    fireEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Settings page')).toBeVisible()
  })

  it('is undefined outside the tab shell', () => {
    let selectTab: unknown = 'unset'
    function Probe() {
      selectTab = useSelectTab()
      return null
    }
    render(<Probe />)
    expect(selectTab).toBeUndefined()
  })
})

describe('useTabActive', () => {
  function ActiveProbe() {
    return <p>{useTabActive() ? 'library shown' : 'library hidden'}</p>
  }

  it('tells a tab’s content whether its tab is the one shown', () => {
    render(
      <Tabs
        tabs={makeTabs(() => (
          <ActiveProbe />
        ))}
        initial="library"
      />
    )
    expect(screen.getByText('library shown')).toBeInTheDocument()

    fireEvent.click(tab('Settings'))
    expect(screen.getByText('library hidden')).toBeInTheDocument()

    fireEvent.click(tab('Library'))
    expect(screen.getByText('library shown')).toBeInTheDocument()
  })

  it('is true outside the tab shell', () => {
    render(<ActiveProbe />)
    expect(screen.getByText('library shown')).toBeInTheDocument()
  })
})

describe('ActiveWithin', () => {
  function Probe() {
    return <p>{useTabActive() ? 'part shown' : 'part hidden'}</p>
  }

  it('narrows useTabActive to a part of a tab that hides itself', () => {
    render(
      <Tabs
        tabs={makeTabs(() => (
          <>
            <ActiveWithin shown>
              <Probe />
            </ActiveWithin>
            <ActiveWithin shown={false}>
              <Probe />
            </ActiveWithin>
          </>
        ))}
        initial="library"
      />
    )
    expect(screen.getByText('part shown')).toBeInTheDocument()
    expect(screen.getByText('part hidden')).toBeInTheDocument()

    // The tab hidden: no part of it is shown.
    fireEvent.click(tab('Settings'))
    expect(screen.queryByText('part shown')).toBeNull()
    expect(screen.getAllByText('part hidden')).toHaveLength(2)
  })
})

describe('Tabs haptics', () => {
  beforeEach(() => vi.mocked(haptic).mockClear())

  it('a tap that switches tabs ticks selection, once', () => {
    render(<Tabs tabs={makeTabs()} />)
    fireEvent.click(tab('Library'))
    expect(haptic).toHaveBeenCalledExactlyOnceWith('selection')
  })

  it('a tap on the tab already shown makes none', () => {
    render(<Tabs tabs={makeTabs()} />)
    fireEvent.click(tab('Ask'))
    expect(haptic).not.toHaveBeenCalled()
  })

  it('a switch made by the app (not a tab tap) makes none', () => {
    function GoToSettings() {
      const selectTab = useSelectTab()
      return (
        <button type="button" onClick={() => selectTab?.('settings')}>
          Go to settings
        </button>
      )
    }
    render(
      <Tabs
        tabs={makeTabs(() => (
          <GoToSettings />
        ))}
        initial="library"
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
    expect(tab('Settings')).toHaveAttribute('aria-selected', 'true')
    expect(haptic).not.toHaveBeenCalled()
  })
})
