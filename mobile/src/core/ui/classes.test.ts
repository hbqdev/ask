import { describe, expect, it } from 'vitest'

import {
  chipClass,
  GROUP,
  READABLE,
  SECTION_TITLE,
  SEPARATOR,
  SEGMENT_TRACK,
  segmentClass
} from '@/core/ui/classes'

describe('the shared class names', () => {
  it('a section title is small, uppercase and 60% foreground', () => {
    expect(SECTION_TITLE).toBe(
      'px-4 pb-2 text-xs font-medium uppercase tracking-wide text-foreground/60'
    )
  })

  it('a group is a rounded card', () => {
    expect(GROUP).toBe('rounded-2xl bg-card')
  })

  it('a row separator is an inset hairline along the bottom', () => {
    expect(SEPARATOR).toBe(
      'after:absolute after:bottom-0 after:left-4 after:right-0 after:h-px after:bg-border'
    )
  })

  it('a segmented control sits on a muted track', () => {
    expect(SEGMENT_TRACK).toBe('flex gap-1 rounded-xl bg-muted p-1')
  })

  it('the chosen segment is the raised thumb; the others are muted and dim when pressed', () => {
    expect(segmentClass(true)).toBe(
      'bg-thumb text-foreground shadow-sm dark:shadow-none'
    )
    expect(segmentClass(false)).toBe('text-muted-foreground active:opacity-50')
  })

  it('a chip that is on inverts; one that is off is muted', () => {
    expect(chipClass(true)).toBe('bg-foreground text-background')
    expect(chipClass(false)).toBe('bg-muted text-foreground')
  })

  it('a readable column is centred, at most 720 px wide', () => {
    expect(READABLE).toBe('mx-auto w-full max-w-[720px]')
  })
})
