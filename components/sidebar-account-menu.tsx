'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

import type { User } from '@supabase/supabase-js'
import {
  IconLogin2,
  IconLogout,
  IconSettings,
  IconUserCircle
} from '@tabler/icons-react'

import { createClient } from '@/lib/supabase/client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { SettingsDialog } from './settings-dialog'

function getInitials(name: string, email: string | undefined) {
  if (name && name !== 'User') {
    const names = name.split(' ')
    if (names.length > 1) {
      return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase()
    }
    return name.substring(0, 2).toUpperCase()
  }
  if (email) {
    return email.split('@')[0].substring(0, 2).toUpperCase()
  }
  return 'U'
}

/**
 * The sidebar-footer account entry — avatar (or a generic user icon for
 * guests) opening an upward menu with the account summary, Settings, and
 * Log out / Sign in. This replaces both the old top-right avatar menu and
 * the footer's bare Settings gear, matching the bottom-left account pattern
 * of comparable apps.
 */
export default function SidebarAccountMenu({ user }: { user: User | null }) {
  const router = useRouter()
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const userName =
    user?.user_metadata?.full_name || user?.user_metadata?.name || 'User'
  const avatarUrl =
    user?.user_metadata?.avatar_url || user?.user_metadata?.picture

  const handleLogout = async () => {
    await createClient().auth.signOut()
    router.push('/')
    router.refresh()
  }

  // Let the menu finish closing before mounting the dialog — opening it in
  // the same tick fights the menu's focus restore (same pattern the old
  // top-right menu used for the account dialog).
  const handleOpenSettings = () => {
    setMenuOpen(false)
    window.setTimeout(() => setSettingsOpen(true), 0)
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Account"
            className="flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-xl w-full transition-all duration-200 cursor-pointer select-none text-muted-foreground hover:bg-muted/60 hover:text-foreground hover:scale-105 active:scale-95"
          >
            {user ? (
              <Avatar className="size-6">
                <AvatarImage src={avatarUrl} alt={userName} />
                <AvatarFallback className="text-[10px]">
                  {getInitials(userName, user.email)}
                </AvatarFallback>
              </Avatar>
            ) : (
              <IconUserCircle className="size-5" />
            )}
            <span className="text-[10px] font-medium leading-none">
              Account
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60" side="top" align="start">
          {user && (
            <>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium leading-none truncate">
                    {userName}
                  </p>
                  <p className="text-xs leading-none text-muted-foreground truncate">
                    {user.email}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onSelect={event => {
              event.preventDefault()
              handleOpenSettings()
            }}
          >
            <IconSettings className="size-4" />
            <span>Settings</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {user ? (
            <DropdownMenuItem onClick={handleLogout}>
              <IconLogout className="size-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem asChild>
              <Link href="/auth/login">
                <IconLogin2 className="size-4" />
                <span>Sign in</span>
              </Link>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={user}
      />
    </>
  )
}
