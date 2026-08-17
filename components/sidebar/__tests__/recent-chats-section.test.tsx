import React from 'react'

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// ChatMenuItem (rendered per row) pulls in next/navigation + a delete server
// action. Stub them so the section renders in isolation.
vi.mock('next/navigation', () => ({
  usePathname: () => '/search/active-chat',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() })
}))

vi.mock('@/lib/actions/chat', () => ({
  deleteChat: vi.fn()
}))

// The sidebar primitives read useSidebar() (needs a SidebarProvider). Its
// provider calls useIsMobile(), which touches window.matchMedia — stub it to a
// stable desktop value so the real provider mounts in jsdom.
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false
}))

import { SidebarProvider } from '@/components/ui/sidebar'

import { type RecentChat, RecentChatsSection } from '../recent-chats-section'

const renderSection = (ui: React.ReactElement) =>
  render(<SidebarProvider>{ui}</SidebarProvider>)

const at = (iso: string) => new Date(iso)
const NOW = new Date()
const todayAt = (h: number) =>
  new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), h)
const yesterdayAt = (h: number) => {
  const d = todayAt(h)
  d.setDate(d.getDate() - 1)
  return d
}

const CHATS: RecentChat[] = [
  {
    id: 'a',
    title: 'Today chat',
    lastViewedAt: todayAt(10),
    createdAt: at('2026-01-01T00:00:00Z')
  },
  {
    id: 'b',
    title: 'Yesterday chat',
    lastViewedAt: yesterdayAt(10),
    createdAt: at('2026-01-01T00:00:00Z')
  },
  {
    id: 'c',
    title: 'Old chat',
    lastViewedAt: null,
    createdAt: at('2026-01-01T00:00:00Z')
  }
]

describe('RecentChatsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders a row per chat, date-grouped Today / Yesterday / Previous', () => {
    renderSection(<RecentChatsSection chats={CHATS} />)

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByText('Previous')).toBeInTheDocument()

    expect(screen.getByText('Today chat')).toBeInTheDocument()
    expect(screen.getByText('Yesterday chat')).toBeInTheDocument()
    expect(screen.getByText('Old chat')).toBeInTheDocument()
  })

  test('links "See all" through to the full library', () => {
    renderSection(<RecentChatsSection chats={CHATS} />)
    const seeAll = screen.getByRole('link', { name: /see all/i })
    expect(seeAll).toHaveAttribute('href', '/library')
  })

  test('shows an empty state and no group labels when there are no chats', () => {
    renderSection(<RecentChatsSection chats={[]} />)

    expect(screen.getByText('No chats yet')).toBeInTheDocument()
    expect(screen.queryByText('Today')).not.toBeInTheDocument()
    expect(screen.queryByText('Yesterday')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /see all/i })
    ).not.toBeInTheDocument()
  })

  test('applies the caller className to the group so it can hide on the icon rail', () => {
    const { container } = renderSection(
      <RecentChatsSection
        chats={CHATS}
        className="group-data-[collapsible=icon]:hidden"
      />
    )
    const group = container.querySelector('[data-sidebar="group"]')
    expect(group).not.toBeNull()
    expect(group).toHaveClass('group-data-[collapsible=icon]:hidden')
  })

  test('highlights the row for the active chat (matches the pathname)', () => {
    // usePathname is mocked to /search/active-chat.
    renderSection(
      <RecentChatsSection
        chats={[
          {
            id: 'active-chat',
            title: 'The open one',
            lastViewedAt: todayAt(9),
            createdAt: at('2026-01-01T00:00:00Z')
          }
        ]}
      />
    )
    const row = screen.getByText('The open one').closest('a')
    expect(row).not.toBeNull()
    // SidebarMenuButton stamps data-active on the active row.
    expect(row).toHaveAttribute('data-active', 'true')
  })
})
