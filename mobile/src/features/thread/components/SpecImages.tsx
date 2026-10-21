// The images an answer's spec fences carry, in a row that scrolls sideways.
// A tap opens the page the image came from, or the image itself when the
// model gave no page.

import { openLink } from '@/features/thread/components/open-link'
import type { SpecImage } from '@/features/thread/model/spec'

export function SpecImages({ images }: { images: SpecImage[] }) {
  if (images.length === 0) return null
  return (
    <div className="-mx-4 flex snap-x gap-3 overflow-x-auto overscroll-x-contain px-4 pb-1">
      {images.map((image, i) => (
        <figure key={`${i}:${image.src}`} className="w-48 shrink-0 snap-start">
          <button
            type="button"
            aria-label={image.title ? undefined : 'Open image'}
            onClick={() => openLink(image.sourceUrl ?? image.src)}
            className="block w-full touch-manipulation active:opacity-80"
          >
            <img
              src={image.src}
              alt={image.title ?? ''}
              loading="lazy"
              className="aspect-[4/3] w-full rounded-xl bg-foreground/5 object-cover"
            />
          </button>
          {image.title && (
            <figcaption className="mt-1 truncate text-xs text-foreground/50">
              {image.title}
            </figcaption>
          )}
        </figure>
      ))}
    </div>
  )
}
