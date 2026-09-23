import React from 'react'

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'

import { deleteCookie, getCookie } from '@/lib/utils/cookies'

import { SourceSelector } from '../source-selector'

// The popover row's label text and the trigger button's text can both
// match the same string (e.g. "Web" appears in both when Web is the only
// active source), so scope clicks to the row <div>, not any element.
function clickRow(label: string) {
  const match = screen
    .getAllByText(label)
    .find(el => el.tagName === 'DIV' && el.className.includes('font-medium'))
  if (!match) throw new Error(`No popover row found for label "${label}"`)
  fireEvent.click(match)
}

// The trigger carries a fixed aria-label (its visible label collapses to an
// icon on mobile), so its accessible name is "Select sources", not the label.
function getTrigger() {
  return screen.getByRole('button', { name: /select sources/i })
}

function openPopover() {
  fireEvent.click(getTrigger())
}

function readSourcesCookie(): string[] {
  const cookieValue = getCookie('sources')
  return JSON.parse(decodeURIComponent(cookieValue ?? '["web"]'))
}

describe('SourceSelector', () => {
  beforeEach(() => {
    deleteCookie('sources')
  })

  test('defaults to Web only when no cookie is set', () => {
    render(<SourceSelector />)
    expect(getTrigger()).toHaveTextContent('Web')
  })

  test('opens the popover and shows all three source options', () => {
    render(<SourceSelector />)
    openPopover()

    expect(screen.getByText('Academic')).toBeInTheDocument()
    expect(screen.getByText('Social Media')).toBeInTheDocument()
  })

  test('toggling Web off is now allowed (no longer hard-locked)', () => {
    render(<SourceSelector />)
    openPopover()

    // Turn Academic on first so Web isn't the last remaining source.
    clickRow('Academic')
    // Now toggle Web off.
    clickRow('Web')

    expect(readSourcesCookie()).toEqual(['academic'])
  })

  test('blocks toggling off the last remaining source', () => {
    render(<SourceSelector />)
    openPopover()

    // Only Web is active; clicking its row should be a no-op.
    clickRow('Web')

    expect(readSourcesCookie()).toEqual(['web'])
  })

  test('allows selecting Academic-only by adding then removing Web', () => {
    render(<SourceSelector />)
    openPopover()

    clickRow('Academic')
    clickRow('Web')

    expect(readSourcesCookie()).toEqual(['academic'])
  })

  test('allows selecting all three sources simultaneously', () => {
    render(<SourceSelector />)
    openPopover()

    clickRow('Academic')
    clickRow('Social Media')

    expect(readSourcesCookie().sort()).toEqual(['academic', 'social', 'web'])
  })

  test('trigger label reflects the first source plus a count of extras', () => {
    render(<SourceSelector />)
    openPopover()
    clickRow('Academic')

    expect(screen.getByText('Web +1')).toBeInTheDocument()
  })
})
