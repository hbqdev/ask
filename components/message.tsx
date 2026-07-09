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

const customComponents = {
  a: Citing
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
