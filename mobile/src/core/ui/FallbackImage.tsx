// An image that never shows as broken: it loads lazily and decodes off the
// main thread, and if it fails, `fallback` takes its place. A new `src` gets
// a fresh try.

import { useState, type ReactNode } from 'react'

export type FallbackImageProps = {
  src: string
  alt: string
  className?: string
  /** Shown in the image's place once it fails to load. */
  fallback: ReactNode
}

export function FallbackImage({
  src,
  alt,
  className,
  fallback
}: FallbackImageProps) {
  // The source that failed: a failure belongs to that source only.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (failedSrc === src) return <>{fallback}</>
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(src)}
      className={className}
    />
  )
}
