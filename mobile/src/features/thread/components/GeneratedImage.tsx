// An image the generateImage tool made: a placeholder while it is being
// made, then the image, which opens full size in the in-app browser. A call
// that errored outright shows nothing (the model's retry renders the real
// image, and if every attempt failed the answer text says so), matching the
// web's components/generated-image-section.tsx.

import type { UIMessage } from 'ai'

import { openLink } from '@/features/thread/components/open-link'

type Part = UIMessage['parts'][number]

type ImageOutput =
  | { imageUrl: string; prompt: string; aspectRatio?: string }
  | { error: string }

export type GeneratedImageProps = {
  /** A tool-generateImage part, or a reloaded dynamic-tool generateImage. */
  part: Part
  /** The API base: the tool returns the image path relative to it. */
  baseUrl: string
}

/** The image's absolute URL: a path the server returned is under the API base. */
function absoluteUrl(imageUrl: string, baseUrl: string): string {
  return imageUrl.startsWith('/')
    ? `${baseUrl.replace(/\/+$/, '')}${imageUrl}`
    : imageUrl
}

export function GeneratedImage({ part, baseUrl }: GeneratedImageProps) {
  const { state, input, output } = part as {
    state?: string
    input?: { prompt?: string }
    output?: ImageOutput
  }

  if (state === 'output-error') return null

  if (state !== 'output-available' || !output) {
    return (
      <div
        role="status"
        aria-label="Generating image"
        className="max-w-md rounded-2xl bg-foreground/5 p-3"
      >
        <div className="aspect-square w-full motion-safe:animate-pulse rounded-xl bg-foreground/10" />
        {input?.prompt && (
          <p className="mt-2 truncate text-xs text-foreground/50">
            {input.prompt}
          </p>
        )}
      </div>
    )
  }

  if ('error' in output) {
    return (
      <p className="rounded-2xl bg-foreground/5 p-3 text-sm text-foreground/60">
        Image generation failed: {output.error}
      </p>
    )
  }

  // A malformed (or oddly reloaded) output has no image to show.
  if (typeof output.imageUrl !== 'string') return null

  const src = absoluteUrl(output.imageUrl, baseUrl)
  return (
    <figure className="max-w-md">
      <button
        type="button"
        onClick={() => openLink(src)}
        className="block w-full touch-manipulation active:opacity-80"
      >
        <img
          src={src}
          alt={output.prompt}
          className="selectable h-auto max-w-full rounded-2xl"
        />
      </button>
      <figcaption className="mt-1.5 truncate text-xs text-foreground/50">
        {output.prompt}
      </figcaption>
    </figure>
  )
}
