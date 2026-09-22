import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SearchResultItem } from '@/lib/types'

import { CitationLink } from '../citation-link'

// jsdom has no PointerEvent, so fireEvent.pointer* would drop pointerType.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventShim extends MouseEvent {
    pointerType: string
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerType = init.pointerType ?? ''
    }
  }
  window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent
}

const source: SearchResultItem = {
  title: 'Node.js previous releases',
  url: 'https://nodejs.org/en/about/previous-releases',
  content: 'Major Node.js versions enter Current release status for six months.'
}

function renderChip(citationData?: SearchResultItem) {
  render(
    <CitationLink href={source.url} citationData={citationData}>
      1
    </CitationLink>
  )
  return screen.getByRole('link', { name: '1' })
}

function tap(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: 'touch' })
  // fireEvent returns false when the handler called preventDefault().
  return fireEvent.click(el)
}

describe('CitationLink on touch', () => {
  it('first tap opens the preview instead of navigating', () => {
    const chip = renderChip(source)
    expect(tap(chip)).toBe(false)
    expect(screen.getByText(source.title)).toBeInTheDocument()
    expect(screen.getByText(/Open source/)).toBeInTheDocument()
  })

  it('second tap navigates', () => {
    const chip = renderChip(source)
    tap(chip)
    expect(tap(chip)).toBe(true)
  })

  it('the Open source link inside the preview targets the source', () => {
    const chip = renderChip(source)
    tap(chip)
    const link = screen.getByText(/Open source/).closest('a')!
    expect(link).toHaveAttribute('href', source.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('a chip without resolved citation data stays a plain link', () => {
    const chip = renderChip(undefined)
    expect(tap(chip)).toBe(true)
    expect(chip).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByText(/Open source/)).not.toBeInTheDocument()
  })
})

describe('CitationLink with a mouse', () => {
  it('hover opens the preview without the touch-only link', () => {
    const chip = renderChip(source)
    fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
    expect(screen.getByText(source.title)).toBeInTheDocument()
    expect(screen.queryByText(/Open source/)).not.toBeInTheDocument()
  })

  it('click navigates straight away', () => {
    const chip = renderChip(source)
    fireEvent.pointerDown(chip, { pointerType: 'mouse' })
    expect(fireEvent.click(chip)).toBe(true)
    expect(chip).toHaveAttribute('rel', 'noopener noreferrer')
  })
})
