'use client'

import { Streamdown } from 'streamdown'

import { cn } from '@/lib/utils'

// Show an unfinished link's text instead of Streamdown's default placeholder
// href, which sanitize strips and rehype-harden then renders as "[blocked]"
// (see STREAMDOWN_REMEND_OPTIONS in components/message.tsx).
const REMEND_OPTIONS = { linkMode: 'text-only' } as const

export function ReasoningContent({ reasoning }: { reasoning: string }) {
  return (
    <div className="overflow-auto">
      <div className={cn('prose-sm dark:prose-invert max-w-none')}>
        <Streamdown remend={REMEND_OPTIONS}>{reasoning}</Streamdown>
      </div>
    </div>
  )
}
