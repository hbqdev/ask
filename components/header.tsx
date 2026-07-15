'use client'

import React from 'react'

import { User } from '@supabase/supabase-js'

import { useChatHeaderInfo } from '@/lib/contexts/chat-header-context'
import { cn } from '@/lib/utils'

import { useSidebar } from '@/components/ui/sidebar'

import { ChatHeader } from './chat-header'
import GuestMenu from './guest-menu'
import UserMenu from './user-menu'

interface HeaderProps {
  user: User | null
}

export const Header: React.FC<HeaderProps> = ({ user }) => {
  const { open } = useSidebar()
  const { info: chatHeaderInfo } = useChatHeaderInfo()

  return (
    <header
      className={cn(
        'absolute top-0 right-0 p-2 md:p-3 flex justify-between items-center z-10 backdrop-blur-sm lg:backdrop-blur-none bg-background/80 lg:bg-transparent transition-[width] duration-200 ease-linear',
        open ? 'md:w-[calc(100%-var(--sidebar-width))]' : 'md:w-full',
        'w-full',
        // When the sidebar is collapsed, its toggle button floats at the
        // top-left (absolute, p-4 inset). Reserve left space so the chat
        // title doesn't render underneath it. Needs md:pl-14 as well — the
        // header's md:p-3 (a responsive variant) would otherwise override a
        // base-only pl-14 at desktop widths. No offset when the sidebar is
        // open — the toggle lives inside the sidebar then.
        !open && 'pl-14 md:pl-14'
      )}
    >
      <div className="min-w-0">
        {chatHeaderInfo && (
          <ChatHeader
            chatId={chatHeaderInfo.chatId}
            title={chatHeaderInfo.title}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        {user ? <UserMenu user={user} /> : <GuestMenu />}
      </div>
    </header>
  )
}

export default Header
