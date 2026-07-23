'use client'

import { WildBreathGlyph } from './ui/wild-breath-logo'

type GenerateImageOutput =
  | { imageUrl: string; modelId: string; prompt: string; aspectRatio?: string }
  | { error: string }

export function GeneratedImageSection({ part }: { part: any }) {
  const prompt: string = part.input?.prompt ?? ''
  if (part.state !== 'output-available') {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-4 flex items-center gap-3">
        <WildBreathGlyph className="size-5 shrink-0" spin />
        <div className="min-w-0">
          <div className="h-40 w-full max-w-md rounded-lg bg-muted animate-pulse" />
          {prompt && (
            <p className="mt-2 text-xs text-muted-foreground truncate">
              {prompt}
            </p>
          )}
        </div>
      </div>
    )
  }
  const output = part.output as GenerateImageOutput
  if ('error' in output) {
    return (
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        Image generation failed: {output.error}
      </div>
    )
  }
  return (
    <figure className="max-w-xl">
      <a href={output.imageUrl} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={output.imageUrl}
          alt={output.prompt}
          className="rounded-xl border border-border max-w-full h-auto"
        />
      </a>
      <figcaption className="mt-1.5 text-xs text-muted-foreground truncate">
        {output.prompt} · {output.modelId}
      </figcaption>
    </figure>
  )
}
