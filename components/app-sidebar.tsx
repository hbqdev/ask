'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'

import type { User } from '@supabase/supabase-js'
import {
  IconCompass,
  IconHome,
  IconLibrary,
  IconPlus
} from '@tabler/icons-react'

import { SHORTCUT_EVENTS } from '@/lib/keyboard-shortcuts'
import { cn } from '@/lib/utils'

import { useClientSettingEnabled } from '@/hooks/use-client-setting'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar'

import {
  type RecentChat,
  RecentChatsSection
} from './sidebar/recent-chats-section'
import {
  applyOptimisticRecent,
  pruneReconciledOverrides,
  type RecentOverrides
} from './sidebar/recent-optimistic'
import { WildBreathLogo } from './ui/wild-breath-logo'
import SidebarAccountMenu from './sidebar-account-menu'
import { SidebarWeather } from './sidebar-weather'

const NAV_ITEMS = [
  { href: '/', icon: IconHome, label: 'Home', exact: true },
  { href: '/discover', icon: IconCompass, label: 'Discover', exact: false },
  { href: '/library', icon: IconLibrary, label: 'Library', exact: false }
]

// Events that mean the Recent list / count are now stale: a turn finished (new
// chat + generated title), a chat was deleted, or a chat was reopened (bumped
// to the top). Each triggers a debounced router.refresh() so the server
// re-renders the sidebar with fresh data. Coalescing bursts (e.g. a delete
// firing both `current-chat-deleted` and `chat-history-updated`) into one
// refresh keeps this cheap.
//
// The refresh alone is NOT enough for a live reorder: its revalidation is
// issued from the stream's `onFinish` (after the response commits) and reads
// are stale-while-revalidate, so the server can hand back the OLD order (see
// lib/actions/chat.ts:124-148). So on top of the refresh we keep a client-side
// optimistic layer (bump / insert / delete overrides, max-merged with the
// server prop) that reorders INSTANTLY and can't be undone by a stale refresh.
const REFRESH_EVENTS = [
  'chat-history-updated',
  'current-chat-deleted',
  'chat-bump'
]

export default function AppSidebar({
  user,
  recentChats,
  chatCount
}: {
  user: User | null
  recentChats: RecentChat[]
  chatCount: number
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { isMobile, setOpenMobile } = useSidebar()

  // Same setting the chat panel reads, so the Settings toggle keeps the sidebar
  // weather card in sync with the (now removed) home-screen widget.
  const showWeatherWidget = useClientSettingEnabled('showWeatherWidget')

  // Client-side optimistic overrides layered on top of the server prop. These
  // give an INSTANT reorder/remove that survives a stale router.refresh() via
  // the max-merge in applyOptimisticRecent (see recent-optimistic.ts). Written
  // only from event callbacks (bump / delete) — never synchronously in an
  // effect body.
  const [overrides, setOverrides] = useState<RecentOverrides>({})

  // Reconcile during render — the sanctioned "adjust state when a prop changes"
  // pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders),
  // NOT an effect — so a fresh server prop drops the overrides it has already
  // caught up on and the map can't grow without bound. pruneReconciledOverrides
  // returns the same reference when nothing changed, so React bails out with no
  // extra render and this can't loop.
  const [seenServer, setSeenServer] = useState(recentChats)
  if (seenServer !== recentChats) {
    setSeenServer(recentChats)
    setOverrides(prev => pruneReconciledOverrides(recentChats, prev))
  }

  // Optimistic reorder/remove in response to the chat events, BEFORE (and
  // independent of) the server round-trip. setState inside an event callback is
  // fine; it's synchronous-in-effect-body that cascades.
  useEffect(() => {
    const onBump = (event: Event) => {
      const id = (event as CustomEvent<{ chatId?: string }>).detail?.chatId
      if (!id) return
      setOverrides(prev => ({
        ...prev,
        [id]: { ...prev[id], lastViewedAt: Date.now(), deleted: false }
      }))
    }
    const onDeleted = (event: Event) => {
      const id = (event as CustomEvent<{ chatId?: string }>).detail?.chatId
      if (!id) return
      setOverrides(prev => ({ ...prev, [id]: { ...prev[id], deleted: true } }))
    }
    window.addEventListener('chat-bump', onBump)
    window.addEventListener('current-chat-deleted', onDeleted)
    return () => {
      window.removeEventListener('chat-bump', onBump)
      window.removeEventListener('current-chat-deleted', onDeleted)
    }
  }, [])

  // The list actually rendered: server prop with the optimistic layer applied.
  // A brand-new chat surfaces through the SAME `chat-bump` path: chat.tsx now
  // fires a bump with the new chat id when it starts one (its id isn't in the
  // server list yet, so applyOptimisticRecent inserts it at the top with a
  // placeholder that the next refresh reconciles to the generated-title row).
  const mergedChats = useMemo(
    () => applyOptimisticRecent(recentChats, overrides),
    [recentChats, overrides]
  )

  // Live-refresh the server-rendered Recent list + count. The sidebar itself is
  // a client island, but its data comes from the server layout, so a
  // router.refresh() re-runs `getRecentChats`/`countChats` and hands down fresh
  // props without a manual reload. This RECONCILES the optimistic layer above
  // (titles, cross-tab deletes, renames); the overrides bridge the gap until it
  // lands, and outlast it when it returns stale.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => router.refresh(), 400)
    }
    REFRESH_EVENTS.forEach(event =>
      window.addEventListener(event, scheduleRefresh)
    )
    return () => {
      REFRESH_EVENTS.forEach(event =>
        window.removeEventListener(event, scheduleRefresh)
      )
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [router])

  // Close the mobile drawer after a tap so it doesn't cover the destination.
  // Desktop (persistent sidebar) is unaffected — guard on isMobile.
  const closeDrawerOnMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  // Dispatch the same event the keyboard shortcut uses, so the chat panel's
  // handleNewChat resets state (chatId, messages, input, files, error modal)
  // before the route change lands. Plain <Link href="/"> alone doesn't reset
  // state and Next.js 16 component caching leaves the old chatId in place —
  // navigating from within an existing chat would land on "/" without ever
  // starting a new one until a hard refresh.
  const handleNewChatClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return
    }
    window.dispatchEvent(new Event(SHORTCUT_EVENTS.newChat))
  }

  return (
    <Sidebar side="left" variant="sidebar" collapsible="icon">
      <SidebarHeader className="gap-3 border-b border-border/40 px-2 py-4">
        <Link
          href="/"
          onClick={closeDrawerOnMobile}
          className="flex size-9 items-center justify-center self-center rounded-lg transition-colors duration-150 hover:bg-muted/50"
        >
          <WildBreathLogo className="size-6" />
        </Link>

        {/* Weather card — directly under the brand, expanded only. Gated by the
            Settings toggle; hidden on the icon rail. */}
        {showWeatherWidget && (
          <SidebarWeather className="group-data-[collapsible=icon]:hidden" />
        )}

        {/* Expanded: full-width labelled New-chat button. */}
        <Link
          href="/"
          title="New chat"
          onClick={e => {
            handleNewChatClick(e)
            closeDrawerOnMobile()
          }}
          className="flex items-center gap-2 rounded-xl bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/20 group-data-[collapsible=icon]:hidden"
        >
          <IconPlus className="size-4" strokeWidth={2.5} />
          New chat
        </Link>

        {/* Collapsed (icon rail): the icon-only New-chat tile, as today. */}
        <Link
          href="/"
          title="New chat"
          onClick={e => {
            handleNewChatClick(e)
            closeDrawerOnMobile()
          }}
          className="hidden size-9 items-center justify-center self-center rounded-xl bg-primary/10 text-primary transition-all duration-200 hover:scale-110 hover:bg-primary/20 active:scale-95 group-data-[collapsible=icon]:flex"
        >
          <IconPlus className="size-4" strokeWidth={2.5} />
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2 py-2">
        {/* Expanded nav — labelled rows. */}
        <nav className="flex flex-col gap-0.5 px-1 group-data-[collapsible=icon]:hidden">
          {NAV_ITEMS.map(({ href, icon: Icon, label, exact }) => {
            const isActive = exact
              ? pathname === href
              : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                title={label}
                onClick={closeDrawerOnMobile}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm',
                  'transition-colors duration-200 select-none',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
              >
                <Icon className="size-5 shrink-0" />
                <span className="font-medium">{label}</span>
              </Link>
            )
          })}
        </nav>

        {/* Collapsed nav — vertical icon tiles, matching today's rail. */}
        <nav className="hidden flex-col items-center gap-1 group-data-[collapsible=icon]:flex">
          {NAV_ITEMS.map(({ href, icon: Icon, label, exact }) => {
            const isActive = exact
              ? pathname === href
              : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className="w-full"
                title={label}
                onClick={closeDrawerOnMobile}
              >
                <div
                  className={cn(
                    'flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-2.5',
                    'transition-all duration-200 cursor-pointer select-none',
                    'hover:scale-105 active:scale-95',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  <Icon className="size-5" />
                  <span className="text-[10px] font-medium leading-none">
                    {label}
                  </span>
                </div>
              </Link>
            )
          })}
        </nav>

        {/* Recent list — below the nav — expanded (and mobile) only. */}
        <RecentChatsSection
          chats={mergedChats}
          onNavigate={closeDrawerOnMobile}
          className="mt-2 group-data-[collapsible=icon]:hidden"
        />
      </SidebarContent>

      <SidebarFooter className="gap-2 border-t border-border/40 px-2 pb-4 pt-2">
        {/* Real chat total — expanded only (hidden on the icon rail). */}
        <div className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {chatCount === 1 ? '1 chat' : `${chatCount.toLocaleString()} chats`}
        </div>
        <SidebarAccountMenu user={user} />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
