import React from 'react'

import type { User } from '@supabase/supabase-js'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh })
}))

const signOut = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut } })
}))

vi.mock('../settings-dialog', () => ({
  SettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="settings-dialog-open" /> : null
}))

import SidebarAccountMenu from '../sidebar-account-menu'

const authedUser = {
  id: 'u1',
  email: 'night@fury.dev',
  user_metadata: { full_name: 'Night Fury' }
} as unknown as User

function openMenu() {
  const trigger = screen.getByRole('button', { name: /account/i })
  fireEvent.keyDown(trigger, { key: 'Enter' })
}

describe('SidebarAccountMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('signed in: initials on the trigger; menu has profile, Settings, Log out', () => {
    render(<SidebarAccountMenu user={authedUser} />)

    // Avatar fallback initials from the display name.
    expect(screen.getByText('NF')).toBeInTheDocument()

    openMenu()
    expect(screen.getByText('Night Fury')).toBeInTheDocument()
    expect(screen.getByText('night@fury.dev')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('Log out')).toBeInTheDocument()
    expect(screen.queryByText('Sign in')).not.toBeInTheDocument()
  })

  test('guest: menu offers Sign in (linking to login) and Settings, no Log out', () => {
    render(<SidebarAccountMenu user={null} />)

    openMenu()
    const signIn = screen.getByRole('menuitem', { name: /sign in/i })
    expect(signIn).toHaveAttribute('href', '/auth/login')
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.queryByText('Log out')).not.toBeInTheDocument()
  })

  test('Settings opens the settings dialog after the menu closes', async () => {
    render(<SidebarAccountMenu user={authedUser} />)

    openMenu()
    fireEvent.click(screen.getByText('Settings'))
    expect(
      await screen.findByTestId('settings-dialog-open')
    ).toBeInTheDocument()
  })

  test('Log out signs out and navigates home', async () => {
    render(<SidebarAccountMenu user={authedUser} />)

    openMenu()
    fireEvent.click(screen.getByText('Log out'))
    await vi.waitFor(() => {
      expect(signOut).toHaveBeenCalled()
      expect(push).toHaveBeenCalledWith('/')
      expect(refresh).toHaveBeenCalled()
    })
  })
})
