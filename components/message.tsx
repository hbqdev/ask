'use client'

import { math } from '@streamdown/math'
import { defaultRehypePlugins, Streamdown } from 'streamdown'

import type { SearchResultItem } from '@/lib/types'
import { cn } from '@/lib/utils'
import { processCitations } from '@/lib/utils/citation'

import { CitationProvider } from './citation-context'
import { Citing } from './custom-link'

import 'katex/dist/katex.min.css'

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
  const processedMessage = processCitations(message || '', citationMaps || {})

  // Define custom components for links (use Streamdown defaults for code blocks)
  const customComponents = {
    a: Citing
  }

  const rehypePlugins = Object.values(defaultRehypePlugins)

  return (
    <CitationProvider citationMaps={citationMaps}>
      <div
        className={cn(
          'prose-sm prose-neutral prose-a:text-accent-foreground/50',
          className
        )}
      >
        <Streamdown
          plugins={{ math }}
          rehypePlugins={rehypePlugins}
          components={customComponents}
        >
          {processedMessage}
        </Streamdown>
      </div>
    </CitationProvider>
  )
}
