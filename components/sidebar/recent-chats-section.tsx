'use client'

import { useState } from 'react'
import Link from 'next/link'

import { IconArrowRight, IconChevronDown } from '@tabler/icons-react'

import type { Chat } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from '@/components/ui/sidebar'

import { ChatMenuItem } from './chat-menu-item'
import { toDate, useHydrated } from './recent-time'

// The slim row the sidebar Recent list works with — mirrors the projection of
// `getRecentChats` (id/title/lastViewedAt/createdAt) so no full Chat row is
// needed to render the rail.
export type RecentChat = Pick<
  Chat,
  'id' | 'title' | 'lastViewedAt' | 'createdAt'
>

// Persist the section's folded state per-device so it survives reloads.
const RECENT_COLLAPSED_KEY = 'ask:recent-collapsed'

// A chat's effective recency: when it was last reopened, or, for a chat never
// reopened, when it was created. Drives both the date group and the row
// subtitle so the two always agree.
function effectiveDate(chat: RecentChat): Date {
  return toDate(chat.lastViewedAt ?? chat.createdAt)
}

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(RECENT_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

type RecentGroup = { label: string; chats: RecentChat[] }

// Midnight (as epoch ms) starting today and yesterday. `local` uses the
// runtime's zone (the viewer's, in the browser); otherwise UTC — the
// zone-independent boundary used for the server render + hydration pass, so
// server and client produce identical markup before local grouping kicks in.
function dayStarts(now: Date, local: boolean): [number, number] {
  if (local) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    return [today.getTime(), yesterday.getTime()]
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  return [today, today - 24 * 60 * 60 * 1000]
}

// Bucket the already-recency-ordered list into Today / Yesterday / Previous.
// Empty buckets are dropped so no label renders without rows beneath it.
export function groupRecentChats(
  chats: RecentChat[],
  { now = new Date(), local = true }: { now?: Date; local?: boolean } = {}
): RecentGroup[] {
  const [startOfToday, startOfYesterday] = dayStarts(now, local)

  const today: RecentChat[] = []
  const yesterday: RecentChat[] = []
  const previous: RecentChat[] = []

  for (const chat of chats) {
    const when = effectiveDate(chat).getTime()
    if (when >= startOfToday) today.push(chat)
    else if (when >= startOfYesterday) yesterday.push(chat)
    else previous.push(chat)
  }

  return [
    { label: 'Today', chats: today },
    { label: 'Yesterday', chats: yesterday },
    { label: 'Previous', chats: previous }
  ].filter(group => group.chats.length > 0)
}

interface RecentChatsSectionProps {
  chats: RecentChat[]
  /** Applied to the group wrapper — used to hide the section in icon mode. */
  className?: string
  /** Fired when any row/link is clicked (e.g. close the mobile drawer). */
  onNavigate?: () => void
}

/**
 * The sidebar's Recent chats section: a "Recent" group of the most recently
 * active chats, date-grouped Today / Yesterday / Previous, with a "See all"
 * link through to the full `/library` manager. The "Recent" header is a toggle
 * that folds the whole list (persisted per-device). Rendered only in the
 * expanded (and mobile) sidebar; the caller hides it in icon mode via
 * `className`.
 */
export function RecentChatsSection({
  chats,
  className,
  onNavigate
}: RecentChatsSectionProps) {
  // Today/Yesterday are viewer-local days, which the server (UTC) can't know:
  // group by UTC days for the SSR + hydration pass, then regroup locally.
  const hydrated = useHydrated()
  const groups = groupRecentChats(chats, { local: hydrated })

  // Start expanded for the SSR + hydration pass (keeps markup in sync), then
  // read the persisted fold once hydrated. An explicit toggle overrides it.
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(
    null
  )
  const collapsed = collapsedOverride ?? (hydrated && readStoredCollapsed())

  const toggle = () => {
    const next = !collapsed
    setCollapsedOverride(next)
    try {
      localStorage.setItem(RECENT_COLLAPSED_KEY, String(next))
    } catch {
      /* private mode / storage disabled — fold still works for the session */
    }
  }

  return (
    <SidebarGroup className={className}>
      <SidebarGroupLabel asChild>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center rounded-md transition-colors hover:text-foreground"
        >
          <span>Recent</span>
          <IconChevronDown
            className={cn(
              'ml-auto size-3.5 transition-transform duration-200',
              collapsed && '-rotate-90'
            )}
          />
        </button>
      </SidebarGroupLabel>

      {!collapsed &&
        (chats.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No chats yet
          </p>
        ) : (
          <>
            {groups.map(group => (
              <div key={group.label} className="mb-1">
                <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground/70">
                  {group.label}
                </div>
                <SidebarMenu>
                  {group.chats.map(chat => (
                    <ChatMenuItem
                      key={chat.id}
                      chat={chat}
                      displayDate={effectiveDate(chat)}
                      onNavigate={onNavigate}
                    />
                  ))}
                </SidebarMenu>
              </div>
            ))}

            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  className="text-xs text-muted-foreground"
                >
                  <Link href="/library" onClick={onNavigate}>
                    <span>See all</span>
                    <IconArrowRight className="ml-auto size-3.5" />
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </>
        ))}
    </SidebarGroup>
  )
}
