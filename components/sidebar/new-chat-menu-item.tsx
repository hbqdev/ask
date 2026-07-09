'use client'

import Link from 'next/link'

import { IconPlus as Plus } from '@tabler/icons-react'

import { SHORTCUT_EVENTS } from '@/lib/keyboard-shortcuts'

import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

export function NewChatMenuItem() {
  // Dispatch the same event the keyboard shortcut uses, so the chat panel's
  // handleNewChat resets state (chatId, messages, input, files, error modal)
  // before the route change lands. Plain <Link href="/"> alone doesn't reset
  // state and Next.js 16 component caching leaves the old chatId in place.
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return
    }
    window.dispatchEvent(new Event(SHORTCUT_EVENTS.newChat))
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild>
        <Link
          href="/"
          className="flex items-center gap-2"
          onClick={handleClick}
        >
          <Plus className="size-4" />
          <span>New</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
