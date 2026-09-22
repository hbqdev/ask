'use client'

import { memo, useRef, useState } from 'react'
import Link from 'next/link'

import type { SearchResultItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { isCitationLabel } from '@/lib/utils/citation'
import { snippetText } from '@/lib/utils/snippet-text'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@/components/ui/popover'

interface CitationLinkProps {
  href: string
  children: React.ReactNode
  className?: string
  citationData?: SearchResultItem
}

// Helper function to safely extract hostname from URL
const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return 'unknown'
  }
}

export const CitationLink = memo(function CitationLink({
  href,
  children,
  className,
  citationData
}: CitationLinkProps) {
  const [open, setOpen] = useState(false)
  // Touch has no hover, so on a touch/pen pointer the first tap opens the
  // preview instead of navigating; a second tap (or the link inside the
  // preview) goes to the source. Tracked per gesture from pointerType so a
  // mouse on a touchscreen laptop keeps the hover behaviour.
  const lastPointerType = useRef<string>('mouse')
  const [openedByTouch, setOpenedByTouch] = useState(false)
  const childrenText = children?.toString() || ''
  const isCitation = isCitationLabel(childrenText)

  const linkClasses = cn(
    isCitation
      ? 'text-[10px] bg-muted/50 text-muted-foreground/60 rounded-full h-4 px-1.5 inline-flex items-center justify-center hover:bg-primary hover:text-primary-foreground duration-200 no-underline -translate-y-0.5 whitespace-nowrap relative pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-3'
      : 'hover:underline inline-flex items-center gap-1.5',
    className
  )

  // If no citation data, render as simple link
  if (!citationData) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses}
      >
        {children}
      </a>
    )
  }

  // For citations with data, show popover on hover
  if (isCitation && citationData) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClasses}
            onPointerDown={e => {
              lastPointerType.current = e.pointerType
            }}
            // Pointer (not mouse) events so the compatibility mouseenter a
            // tap emits does not open the preview before the click handler.
            onPointerEnter={e => {
              if (e.pointerType === 'mouse') {
                setOpenedByTouch(false)
                setOpen(true)
              }
            }}
            onPointerLeave={e => {
              if (e.pointerType === 'mouse' && !openedByTouch) setOpen(false)
            }}
            onClick={e => {
              const touch =
                lastPointerType.current === 'touch' ||
                lastPointerType.current === 'pen'
              lastPointerType.current = 'mouse'
              if (touch && !open) {
                // First tap: preview only. preventDefault also skips the
                // Radix trigger toggle, so the open state is set here.
                e.preventDefault()
                setOpenedByTouch(true)
                setOpen(true)
              }
              // Otherwise the link navigates as usual (second tap / mouse).
            }}
          >
            {children}
          </a>
        </PopoverTrigger>
        <PopoverContent
          className="w-80 p-0 z-50 shadow-xs"
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={e => {
            // Keep focus (and the on-screen keyboard/scroll) on the page
            // when a tap opens the preview.
            if (openedByTouch) e.preventDefault()
          }}
          onPointerDownOutside={e => {
            // Hover previews close on mouse-leave; a touch-opened preview
            // closes on an outside tap.
            if (!openedByTouch) e.preventDefault()
          }}
        >
          {citationData ? (
            <Link
              href={citationData.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-3 hover:bg-accent/50 transition-colors"
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Avatar className="h-4 w-4 shrink-0">
                    <AvatarImage
                      src={`https://www.google.com/s2/favicons?domain=${getHostname(
                        citationData.url
                      )}`}
                      alt={getHostname(citationData.url)}
                    />
                    <AvatarFallback className="text-xs">
                      {getHostname(citationData.url)[0]?.toUpperCase() || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-xs text-muted-foreground truncate">
                    {getHostname(citationData.url)}
                  </span>
                </div>
                <p className="text-sm font-medium line-clamp-1">
                  {snippetText(citationData.title)}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                  {snippetText(citationData.content)}
                </p>
                {openedByTouch && (
                  <span className="inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary">
                    Open source <span aria-hidden="true">↗</span>
                  </span>
                )}
              </div>
            </Link>
          ) : null}
        </PopoverContent>
      </Popover>
    )
  }

  // For non-numbered citations, render as regular link
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClasses}
    >
      {children}
    </a>
  )
})
