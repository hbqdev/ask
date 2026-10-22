// The research behind an answer: one header line, "Completed N steps" once
// finished, that expands to the steps. While the research is live it stays
// open and reads "Researching…", so the user watches the steps arrive.

import type { UIMessage } from 'ai'
import { useId, useState } from 'react'

import {
  describeResearchStep,
  researchSummary,
  type ResearchStep
} from '@/features/thread/model/research'

type Part = UIMessage['parts'][number]

export type ResearchSectionProps = {
  parts: Part[]
  /** Whether the research is still running (its block is the message's last). */
  live: boolean
}

function StepIndicator({ done }: { done: boolean }) {
  if (done) {
    return (
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-accent">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        <span className="sr-only">Done</span>
      </span>
    )
  }
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className="size-2 motion-safe:animate-pulse rounded-full bg-mark-violet"
      />
      <span className="sr-only">In progress</span>
    </span>
  )
}

function StepRow({ step }: { step: ResearchStep }) {
  return (
    <li className="flex gap-2.5 py-1.5">
      <StepIndicator done={step.done} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground/80">{step.label}</p>
        {step.detail && (
          <p className="line-clamp-2 text-xs text-foreground/60">
            {step.detail}
          </p>
        )}
      </div>
    </li>
  )
}

export function ResearchSection({ parts, live }: ResearchSectionProps) {
  const [opened, setOpened] = useState(false)
  const listId = useId()
  const steps = parts
    .map(describeResearchStep)
    .filter((step): step is ResearchStep => step !== null)
  if (steps.length === 0) return null

  // Live research is always open; a tap then changes nothing, so it collapses
  // once the research finishes.
  const expanded = live || opened

  return (
    <section className="research-section">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        onClick={() => {
          if (!live) setOpened(!opened)
        }}
        className="flex min-h-11 touch-manipulation items-center gap-1.5 text-sm font-medium text-foreground/60 active:opacity-50"
      >
        <span>{researchSummary(parts, live)}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {expanded && (
        <ul id={listId} className="ml-1 border-l border-foreground/10 pl-3">
          {steps.map((step, i) => (
            <StepRow key={i} step={step} />
          ))}
        </ul>
      )}
    </section>
  )
}
