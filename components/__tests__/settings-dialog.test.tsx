import type { User } from '@supabase/supabase-js'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The dialog reaches into theme + the memory tab's data hooks; stub them so we
// can render the shell and assert on tab reachability alone.
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() })
}))
vi.mock('@/components/settings/memory-tab', () => ({
  MemoryTab: () => <div data-testid="memory-tab-content">memory</div>
}))
// The Account tab pulls the delete-account action and supabase client.
vi.mock('@/lib/actions/account', () => ({
  deleteAccount: vi.fn()
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } })
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}))

import { SettingsDialog } from '../settings-dialog'

const testUser = {
  id: 'u1',
  email: 'night@fury.dev',
  user_metadata: { full_name: 'Night Fury' }
} as unknown as User

describe('SettingsDialog tab reachability', () => {
  beforeEach(() => {
    // jsdom has no matchMedia; some UI primitives probe it.
    window.matchMedia ??= vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }) as any
  })

  it('renders EVERY tab in a nav that is not desktop-only', () => {
    // The regression this guards: the only tab navigation was a
    // `hidden lg:flex` sidebar, so below 1024px every tab but the default
    // (Memory, Personalization) was completely unreachable — no way to open
    // the Memory settings at all on a narrower window. There must be a tab
    // control for each section that is NOT gated behind `lg:`.
    render(<SettingsDialog open onOpenChange={() => {}} />)

    for (const label of ['Preferences', 'Personalization', 'Memory']) {
      const buttons = screen.getAllByRole('button', { name: new RegExp(label) })
      // At least one nav button for this tab must live outside a lg-only
      // container (i.e. reachable below the lg breakpoint).
      const reachable = buttons.some(btn => {
        let el: HTMLElement | null = btn
        while (el) {
          if (el.className && /(^|\s)hidden(\s|$)/.test(el.className)) {
            // hidden unless an lg: utility re-shows it → desktop-only
            if (/lg:(flex|block|grid|inline)/.test(el.className)) return false
          }
          el = el.parentElement
        }
        return true
      })
      expect(reachable, `"${label}" tab must be reachable below lg`).toBe(true)
    }
  })

  it('shows the Account tab only when a user is provided', () => {
    const { rerender } = render(<SettingsDialog open onOpenChange={() => {}} />)
    expect(
      screen.queryByRole('button', { name: /Account/ })
    ).not.toBeInTheDocument()

    rerender(<SettingsDialog open onOpenChange={() => {}} user={testUser} />)
    expect(
      screen.getAllByRole('button', { name: /Account/ }).length
    ).toBeGreaterThan(0)
  })

  it('Account tab shows the profile and the delete-account danger zone', () => {
    render(<SettingsDialog open onOpenChange={() => {}} user={testUser} />)

    fireEvent.click(screen.getAllByRole('button', { name: /Account/ })[0])

    expect(screen.getByText('Night Fury')).toBeInTheDocument()
    expect(screen.getByText('night@fury.dev')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /delete account/i })
    ).toBeInTheDocument()
  })
})
