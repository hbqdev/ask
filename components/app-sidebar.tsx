'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import {
  IconCompass,
  IconHome,
  IconLibrary,
  IconPlus
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail
} from '@/components/ui/sidebar'

import { IconLogo } from './ui/icons'

const NAV_ITEMS = [
  { href: '/', icon: IconHome, label: 'Home', exact: true },
  { href: '/discover', icon: IconCompass, label: 'Discover', exact: false },
  { href: '/library', icon: IconLibrary, label: 'Library', exact: false }
]

export default function AppSidebar() {
  const pathname = usePathname()

  return (
    <Sidebar side="left" variant="sidebar" collapsible="offcanvas">
      <SidebarHeader className="flex flex-col items-center py-4 gap-3 border-b border-border/40 px-2">
        <Link
          href="/"
          className="flex items-center justify-center size-9 rounded-lg hover:bg-muted/50 transition-colors duration-150"
        >
          <IconLogo className="size-5" />
        </Link>

        <Link
          href="/"
          title="New chat"
          className="flex items-center justify-center size-9 rounded-xl bg-primary/10 hover:bg-primary/20 text-primary transition-all duration-200 hover:scale-110 active:scale-95"
        >
          <IconPlus className="size-4" strokeWidth={2.5} />
        </Link>
      </SidebarHeader>

      <SidebarContent className="flex flex-col items-center gap-1 py-4 px-2">
        {NAV_ITEMS.map(({ href, icon: Icon, label, exact }) => {
          const isActive = exact
            ? pathname === href
            : pathname.startsWith(href)
          return (
            <Link key={href} href={href} className="w-full" title={label}>
              <div
                className={cn(
                  'flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-xl w-full',
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
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  )
}
