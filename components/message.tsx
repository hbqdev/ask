'use client'

import rehypeExternalLinks from 'rehype-external-links'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown
} from 'streamdown'
import type { PluggableList } from 'unified'

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

  const rehypePlugins: PluggableList = [
    ...Object.values(defaultRehypePlugins),
    [rehypeExternalLinks, { target: '_blank' }],
    rehypeKatex
  ]

  const remarkPlugins: PluggableList = [
    ...Object.values(defaultRemarkPlugins),
    remarkMath
  ]

  return (
    <CitationProvider citationMaps={citationMaps}>
      <div
        className={cn(
          'prose-sm prose-neutral prose-a:text-accent-foreground/50',
          className
        )}
      >
        <Streamdown
          rehypePlugins={rehypePlugins}
          remarkPlugins={remarkPlugins}
          components={customComponents}
        >
          {processedMessage}
        </Streamdown>
      </div>
    </CitationProvider>
  )
}
