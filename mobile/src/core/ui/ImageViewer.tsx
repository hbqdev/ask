// A full-screen image viewer: the images edge to edge on black, one per
// page, swiped sideways with native scroll-snap paging. A page count
// ("2 / 5") sits above the home indicator and a close button below the
// status bar, both clear of the safe-area insets. Escape closes it too.
// While it is open the page behind does not scroll, the status bar's content
// is light over the black, Tab stays on its controls, and on close focus goes
// back to what opened it.
//
// The page never zooms; the image it is on does (usePinchZoom), as in Photos:
// pinched about the fingers, or double-tapped in and out, anywhere on its
// page. While zoomed one finger pans the image and the strip does not page;
// a page change, or closing, unzooms.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { haptic } from '@/core/haptics'
import { FallbackImage } from '@/core/ui/FallbackImage'
import { trapTab, useReturnFocus } from '@/core/ui/focus'
import { requestLightStatusBar } from '@/core/ui/status-bar'
import { usePinchZoom } from '@/core/ui/use-pinch-zoom'

export type ViewerImage = { src: string; alt: string }

export type ImageViewerProps = {
  open: boolean
  images: ViewerImage[]
  /** The image it opens on. */
  start: number
  onClose: () => void
}

export function ImageViewer({ open, ...props }: ImageViewerProps) {
  if (!open) return null
  return <ViewerPanel {...props} />
}

function Placeholder() {
  return (
    <div
      data-testid="viewer-placeholder"
      className="flex size-full items-center justify-center text-white/40"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-12"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5a1 1 0 1 0 0-.01" />
      </svg>
    </div>
  )
}

function ViewerPanel({
  images,
  start,
  onClose
}: Omit<ImageViewerProps, 'open'>) {
  useReturnFocus()
  const [index, setIndex] = useState(start)
  const { zoom, zoomed, reset, handlers, imageRef } = usePinchZoom()
  const dialog = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // The latest onClose, so the key listener isn't re-added on each render.
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = strip.current!
    el.scrollLeft = start * el.clientWidth
  }, [start])

  useEffect(() => {
    dialog.current!.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current()
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const releaseStatusBar = requestLightStatusBar()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      releaseStatusBar()
    }
  }, [])

  // A new page starts unzoomed, before it is painted.
  useLayoutEffect(reset, [index, reset])

  const onScroll = () => {
    const el = strip.current!
    const page = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
    setIndex(Math.min(images.length - 1, Math.max(0, page)))
  }

  const many = images.length > 1
  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={many ? `Image ${index + 1} of ${images.length}` : 'Image'}
      tabIndex={-1}
      onKeyDown={e => trapTab(e.nativeEvent, dialog.current!)}
      className="image-viewer fixed inset-0 z-50 bg-black text-white outline-none"
    >
      <div
        ref={strip}
        data-testid="viewer-strip"
        onScroll={onScroll}
        style={zoomed ? { overflowX: 'hidden' } : undefined}
        className="flex size-full touch-pan-x snap-x snap-mandatory overflow-x-auto overscroll-contain"
      >
        {images.map((image, i) => (
          // Each page clips its image, so a zoomed one never spills onto
          // the next page or widens the strip. The page it is on takes the
          // zoom gestures, black around the image included.
          <div
            key={i}
            className="flex size-full shrink-0 snap-center snap-always items-center justify-center overflow-hidden"
            {...(i === index && {
              ...handlers,
              // Unzoomed, a swipe on the page pages the strip.
              style: { touchAction: zoomed ? 'none' : 'pan-x' }
            })}
          >
            <FallbackImage
              src={image.src}
              alt={image.alt}
              className="max-h-full max-w-full object-contain"
              fallback={<Placeholder />}
              {...(i === index && {
                ref: imageRef,
                style: {
                  transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
                }
              })}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          haptic('light')
          onClose()
        }}
        className="absolute top-[max(0.5rem,env(safe-area-inset-top))] right-[max(0.5rem,env(safe-area-inset-right))] flex size-11 touch-manipulation items-center justify-center rounded-full bg-white/15 text-white backdrop-blur active:bg-white/30"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      {many && (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm font-medium text-white/80 tabular-nums"
        >
          {index + 1} / {images.length}
        </p>
      )}
    </div>,
    document.body
  )
}
