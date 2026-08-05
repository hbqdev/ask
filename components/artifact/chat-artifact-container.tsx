'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useHasUser } from '@/lib/contexts/user-context'
import { cn } from '@/lib/utils'

import { SidebarTrigger } from '@/components/ui/sidebar'

import { InspectorDrawer } from '@/components/inspector/inspector-drawer'
import { InspectorPanel } from '@/components/inspector/inspector-panel'
import { useLibrary } from '@/components/library/library-context'
import { LibraryPanel } from '@/components/library/library-panel'

import { useArtifact } from './artifact-context'

const DEFAULT_WIDTH = 500
const MIN_WIDTH = 320
const MAX_WIDTH = 800
const CHAT_MIN_WIDTH = 360
const RESIZE_OVERLAY_Z_INDEX = 9999

// Helper function to calculate allowed width bounds
function getAllowedWidthBounds(containerWidth: number): {
  allowedMin: number
  allowedMax: number
} {
  const available = Math.max(0, containerWidth - CHAT_MIN_WIDTH)
  const allowedMax = Math.min(MAX_WIDTH, available)

  // If there's no space available, hide the panel entirely
  if (allowedMax === 0) {
    return { allowedMin: 0, allowedMax: 0 }
  }

  // Ensure minimum width doesn't exceed available space
  const allowedMin = Math.min(MIN_WIDTH, allowedMax)
  return { allowedMin, allowedMax }
}

export function ChatArtifactContainer({
  children
}: {
  children: React.ReactNode
}) {
  const { state } = useArtifact()
  const [containerElement, setContainerElement] =
    useState<HTMLDivElement | null>(null)
  const hasAppliedSavedWidthRef = useRef(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const hasUser = useHasUser()
  const { isOpen: libraryOpen } = useLibrary()
  const artifactOpen = state.isOpen && state.part
  const panelOpen = Boolean(artifactOpen || libraryOpen)

  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerElement(node)

    if (!node || hasAppliedSavedWidthRef.current) {
      return
    }

    hasAppliedSavedWidthRef.current = true

    const savedWidth = localStorage.getItem('artifactPanelWidth')
    if (!savedWidth) {
      return
    }

    const parsedWidth = parseInt(savedWidth, 10)
    if (
      isNaN(parsedWidth) ||
      parsedWidth < MIN_WIDTH ||
      parsedWidth > MAX_WIDTH
    ) {
      return
    }

    const { allowedMin, allowedMax } = getAllowedWidthBounds(node.clientWidth)
    const clampedWidth = Math.min(Math.max(parsedWidth, allowedMin), allowedMax)
    setWidth(clampedWidth)
  }, [])

  // Keep width in bounds when container resizes (e.g., window resize)
  useEffect(() => {
    if (!containerElement) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { allowedMin, allowedMax } = getAllowedWidthBounds(
          entry.contentRect.width
        )
        setWidth(prev => Math.min(Math.max(prev, allowedMin), allowedMax))
      }
    })
    ro.observe(containerElement)
    return () => ro.disconnect()
  }, [containerElement])

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const containerRect = containerElement?.getBoundingClientRect()
      if (containerRect) {
        const newWidth = containerRect.right - e.clientX
        const { allowedMin, allowedMax } = getAllowedWidthBounds(
          containerRect.width
        )
        const clampedWidth = Math.min(
          Math.max(newWidth, allowedMin),
          allowedMax
        )
        setWidth(clampedWidth)
        localStorage.setItem('artifactPanelWidth', clampedWidth.toString())
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [containerElement, isResizing])

  return (
    <div className="flex-1 min-h-0 min-w-0 h-full flex">
      <div className="absolute z-50 p-4 transition-opacity duration-[180ms] ease-[var(--motion-ease-out)]">
        {hasUser && <SidebarTrigger className="animate-fade-in" />}
      </div>

      {/* ONE chat instance. `children` (= <Chat>, with its useChat/stream and
          window listeners) used to be rendered twice — a desktop copy in a
          `hidden md:flex` container AND a mobile copy in a `md:hidden` one — so
          the whole component mounted and reconciled twice (CSS just painted one
          per breakpoint). Rendered once here: the chat fills the width below md
          (the resize handle and artifact panel are `hidden md:block` there), and
          at md+ it's a flex sibling of the panel. The container ref + resize
          logic only affect the panel, which is desktop-only, so they're inert
          below md. */}
      <div
        ref={setContainerRef}
        className="flex-1 min-w-0 h-full flex overflow-hidden"
      >
        <div className="flex-1 min-w-0 flex flex-col h-full">{children}</div>

        {/* Resize Handle (desktop only) */}
        {panelOpen && (
          <div
            className={cn(
              'hidden md:block w-1 mx-0.5 my-6 hover:bg-border transition-colors duration-200 cursor-col-resize select-none relative',
              isResizing && 'bg-border/50'
            )}
            onMouseDown={startResize}
          >
            <div className="absolute inset-0 -left-2 -right-2" />
          </div>
        )}

        {/* Right Panel (desktop only) - independent width/opacity animation */}
        <div
          className={cn(
            'hidden md:block bg-background overflow-hidden',
            panelOpen ? 'opacity-100' : 'w-0 opacity-0',
            !isResizing &&
              'transition-[opacity,width] duration-[260ms] ease-[var(--motion-ease-in-out)]'
          )}
          style={{
            width: panelOpen ? `${width}px` : '0px'
          }}
        >
          <div className="h-full" style={{ width: `${width}px` }}>
            {artifactOpen ? (
              <InspectorPanel />
            ) : libraryOpen ? (
              <LibraryPanel />
            ) : null}
          </div>
        </div>
      </div>

      {/* Resize overlay to prevent text selection */}
      {isResizing && (
        <div
          className="fixed inset-0 cursor-col-resize select-none"
          style={{ zIndex: RESIZE_OVERLAY_Z_INDEX }}
        />
      )}

      {/* Mobile inspector drawer — self-gates via useMediaQuery and returns null
          at md+, so it's safe to render unconditionally (no mobile wrapper that
          would duplicate the chat). */}
      <InspectorDrawer />
    </div>
  )
}
