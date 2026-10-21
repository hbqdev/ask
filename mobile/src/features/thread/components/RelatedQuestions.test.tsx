import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RelatedQuestions } from '@/features/thread/components/RelatedQuestions'

const QUERIES = ['How tall is it?', 'Who built it?']

describe('RelatedQuestions', () => {
  it('renders nothing with no queries', () => {
    const { container } = render(
      <RelatedQuestions queries={[]} disabled={false} onAsk={() => {}} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the queries under Related', () => {
    render(
      <RelatedQuestions queries={QUERIES} disabled={false} onAsk={() => {}} />
    )
    expect(screen.getByRole('heading', { name: 'Related' })).toBeInTheDocument()
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(
      QUERIES
    )
  })

  it('asks the tapped query', () => {
    const onAsk = vi.fn()
    render(
      <RelatedQuestions queries={QUERIES} disabled={false} onAsk={onAsk} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Who built it?' }))
    expect(onAsk).toHaveBeenCalledWith('Who built it?')
  })

  it('ignores taps while disabled', () => {
    const onAsk = vi.fn()
    render(<RelatedQuestions queries={QUERIES} disabled onAsk={onAsk} />)
    const button = screen.getByRole('button', { name: 'Who built it?' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onAsk).not.toHaveBeenCalled()
  })
})
