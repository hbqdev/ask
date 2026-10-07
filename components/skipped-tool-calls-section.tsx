'use client'

import { IconSearchOff, IconWorldOff } from '@tabler/icons-react'

import {
  type SkippedToolCalls,
  skippedToolCallsLabel
} from '@/lib/utils/skipped-tool-calls'

/**
 * One row in the research-process step list standing in for every search /
 * fetch call of the turn that was refused without running (round cap, fetch
 * cap, answer-now). Same status-row shape as ClassifierSection, a notch more
 * muted, and nothing to expand: there are no results behind it. The label
 * wraps instead of truncating so the count — the point of the row — is never
 * cut off on a phone.
 */
export function SkippedToolCallsSection({
  summary
}: {
  summary: SkippedToolCalls
}) {
  const Icon = summary.searches > 0 ? IconSearchOff : IconWorldOff
  return (
    <div
      className="flex items-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground/70"
      title="These calls were refused without running: no search or page read was done for them."
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{skippedToolCallsLabel(summary)}</span>
    </div>
  )
}

export default SkippedToolCallsSection
