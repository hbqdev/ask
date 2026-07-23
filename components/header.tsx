'use client'

import React from 'react'

import { useChatHeaderInfo } from '@/lib/contexts/chat-header-context'
import { cn } from '@/lib/utils'

import { useSidebar } from '@/components/ui/sidebar'

import { ChatHeader } from './chat-header'
import GuestMenu from './guest-menu'

interface HeaderProps {
  /**
   * Account access lives in the sidebar footer now, so the header's right
   * side stays empty whenever the sidebar exists. Logged-out visitors on
   * public routes (/, /share) get NO sidebar at all — for them this keeps
   * the old top-right Sign In + settings gear so both stay reachable.
   */
  showGuestMenu?: boolean
}

export const Header: React.FC<HeaderProps> = ({ showGuestMenu = false }) => {
  const { open } = useSidebar()
  const { info: chatHeaderInfo } = useChatHeaderInfo()

  return (
    <header
      className={cn(
        'absolute top-0 right-0 p-2 md:p-3 flex justify-between items-center z-10 backdrop-blur-sm lg:backdrop-blur-none bg-background/80 lg:bg-transparent transition-[width] duration-200 ease-linear',
        open ? 'md:w-[calc(100%-var(--sidebar-width))]' : 'md:w-full',
        'w-full',
        // The sidebar toggle floats at the content area's top-left (absolute,
        // p-4 inset) in BOTH states — it is rendered unconditionally now so it
        // stays reachable while the sidebar is open. Always reserve left space
        // so the chat title never renders underneath it. Needs md:pl-14 too —
        // the header's md:p-3 (a responsive variant) would otherwise override
        // a base-only pl-14 at desktop widths.
        'pl-14 md:pl-14'
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

      {showGuestMenu && (
        <div className="flex items-center gap-2">
          <GuestMenu />
        </div>
      )}
    </header>
  )
}

export default Header
