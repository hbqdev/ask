'use client'

import { useEffect, useRef, useState } from 'react'

import { IconSearch as Search } from '@tabler/icons-react'

import { captureClient } from '@/lib/analytics/posthog-client'
import { cn } from '@/lib/utils'

// Constants for timing delays
const FOCUS_OUT_DELAY_MS = 100 // Delay to ensure focus has actually moved

interface ActionCategory {
  // Cosmic-mockup accent dot shown before the label (parity with .starter .dot).
  dot: string
  label: string
  key: string
}

const actionCategories: ActionCategory[] = [
  {
    dot: '#ff85ac',
    label: 'Decide',
    key: 'decide'
  },
  {
    dot: '#ffca8a',
    label: 'Troubleshoot',
    key: 'troubleshoot'
  },
  {
    dot: '#8ecdf5',
    label: 'How-to',
    key: 'howto'
  },
  {
    dot: '#a596f5',
    label: 'Understand',
    key: 'understand'
  },
  {
    dot: '#7ee0b6',
    label: 'Create',
    key: 'create'
  }
]

// Onboarding examples are tuned to showcase grounded, GenUI-rich answers
// (images, comparison tables, structured depth) for concrete, self-contained
// tasks — the patterns that correlate with follow-up in real usage. Keep each
// example self-contained (no "my notes"/"this file" referencing absent context).
const promptSamples: Record<string, string[]> = {
  troubleshoot: [
    'My car starts then immediately stalls, but the electronics still work',
    'Wi-Fi keeps dropping on one laptop but not my phone — how do I fix it?',
    "My sourdough starter isn't rising after a week — what's wrong?",
    'Next.js build fails with "Module not found" only in production'
  ],
  howto: [
    'Move my photos off Google Photos without losing albums',
    'Set up a Proxmox home server for self-hosting',
    'Convert a folder of .txt files to clean HTML',
    'Set up a Plex media server to stream my movies'
  ],
  decide: [
    'Tesla vs Rivian — which should I buy?',
    'Standing vs sitting desk for lower-back pain — which and why?',
    'A budget mirrorless camera for travel under $1,000',
    'Notion vs Obsidian for a personal knowledge base'
  ],
  understand: [
    'What causes the northern lights?',
    'Why did the dinosaurs really go extinct?',
    'How does a nuclear reactor actually generate electricity?',
    // Timely slot — refresh seasonally (currently WWDC 2026).
    'What did Apple announce at WWDC 2026?'
  ],
  create: [
    'Draft a 5-question Ancient Rome quiz with A–D answers',
    'Outline a peer-support group for a prison setting',
    'Create a high-protein meal plan for a week on a budget',
    'Draft a beginner 3-day-per-week workout split'
  ]
}

interface ActionButtonsProps {
  onSelectPrompt: (prompt: string) => void
  onCategoryClick: (category: string) => void
  onActiveCategoryChange?: (active: boolean) => void
  inputRef?: React.RefObject<HTMLTextAreaElement>
  className?: string
}

export function ActionButtons({
  onSelectPrompt,
  onCategoryClick,
  onActiveCategoryChange,
  inputRef,
  className
}: ActionButtonsProps) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleCategoryClick = (category: ActionCategory) => {
    setActiveCategory(category.key)
    onCategoryClick(category.label)
    onActiveCategoryChange?.(true)
    captureClient('example_category_opened', { category: category.key })
  }

  const handlePromptClick = (prompt: string) => {
    captureClient('example_prompt_clicked', {
      category: activeCategory,
      prompt
    })
    setActiveCategory(null)
    onActiveCategoryChange?.(false)
    onSelectPrompt(prompt)
  }

  const resetToButtons = () => {
    setActiveCategory(null)
    onActiveCategoryChange?.(false)
  }

  // Handle Escape key and clicks outside (including focus loss)
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeCategory) {
        resetToButtons()
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        if (activeCategory) {
          // Check if click is not on the input field
          if (!inputRef?.current?.contains(e.target as Node)) {
            resetToButtons()
          }
        }
      }
    }

    const handleFocusOut = () => {
      // Check if focus is moving outside both the container and input
      setTimeout(() => {
        const activeElement = document.activeElement
        if (
          activeCategory &&
          !containerRef.current?.contains(activeElement) &&
          activeElement !== inputRef?.current
        ) {
          resetToButtons()
        }
      }, FOCUS_OUT_DELAY_MS)
    }

    document.addEventListener('keydown', handleEscape)
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [activeCategory, inputRef])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Action buttons — natural height */}
      <div
        className={cn(
          'flex items-start justify-center pt-2 transition-opacity duration-[180ms] ease-[var(--motion-ease-out)]',
          activeCategory ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
      >
        <div className="flex flex-wrap justify-center gap-2.5 px-2">
          {actionCategories.map(category => (
            <button
              key={category.key}
              type="button"
              className={cn(
                // Cosmic-mockup .starter — theme-aware token border/fill so it
                // stays legible in light mode; the accent dot carries the colour.
                'inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-border bg-foreground/[0.02] px-3.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors',
                'hover:border-foreground/20 hover:text-foreground'
              )}
              onClick={() => handleCategoryClick(category)}
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: category.dot }}
              />
              <span>{category.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Prompt samples — overlays button row, expands downward with z-index */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 z-10 space-y-1 max-h-[220px] overflow-y-auto py-1 transition-opacity duration-[180ms] ease-[var(--motion-ease-out)]',
          !activeCategory ? 'opacity-0 pointer-events-none' : 'opacity-100'
        )}
      >
        {activeCategory &&
          promptSamples[activeCategory]?.map((prompt, index) => (
            <button
              key={index}
              type="button"
              className={cn(
                'w-full rounded-md px-3 py-2 text-left text-sm',
                'transition-colors duration-[140ms] ease-[var(--motion-ease-out)] hover:bg-muted',
                'flex items-center gap-2 group'
              )}
              onClick={() => handlePromptClick(prompt)}
            >
              <Search className="h-3 w-3 text-muted-foreground flex-shrink-0 group-hover:text-foreground" />
              <span className="line-clamp-2">{prompt}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
