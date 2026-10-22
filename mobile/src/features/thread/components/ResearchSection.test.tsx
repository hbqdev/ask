import type { UIMessage } from 'ai'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ResearchSection } from '@/features/thread/components/ResearchSection'

type Part = UIMessage['parts'][number]

const search = (state: string, output?: unknown) =>
  ({
    type: 'tool-search',
    toolCallId: 's1',
    state,
    input: { query: 'tides in Hanoi' },
    output
  }) as Part

const DONE_SEARCH = search('output-available', {
  state: 'complete',
  results: [{ title: 'a', url: 'https://a.test.invalid', content: '' }]
})
const RUNNING_SEARCH = search('input-available')
const REASONING = { type: 'reasoning', text: 'Weighing the sources' } as Part
const EMPTY_RECALL = { type: 'data-recall', data: { chats: [] } } as Part

describe('ResearchSection', () => {
  it('renders nothing when no part is a step', () => {
    const { container } = render(
      <ResearchSection parts={[EMPTY_RECALL]} live={false} />
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument()
  })

  it('is collapsed with the step count when finished', () => {
    render(<ResearchSection parts={[REASONING, DONE_SEARCH]} live={false} />)
    const header = screen.getByRole('button', { name: /Completed 2 steps/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('tides in Hanoi')).not.toBeInTheDocument()
  })

  it('shows each step with its detail when expanded, and collapses again', () => {
    render(<ResearchSection parts={[REASONING, DONE_SEARCH]} live={false} />)
    const header = screen.getByRole('button', { name: /Completed 2 steps/ })
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Thinking')
    expect(rows[0]).toHaveTextContent('Weighing the sources')
    expect(rows[1]).toHaveTextContent('tides in Hanoi')
    expect(rows[1]).toHaveTextContent('1 result')
    expect(rows[1]).toHaveTextContent('Done')
    fireEvent.click(header)
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('is expanded and says Researching while live, marking the active step', () => {
    render(<ResearchSection parts={[REASONING, RUNNING_SEARCH]} live />)
    const header = screen.getByRole('button', { name: /Researching…/ })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Done')
    expect(rows[1]).toHaveTextContent('In progress')
  })

  it('shows reading the attachments, active while live and done after', () => {
    const attachments = (state: string) =>
      ({ type: 'data-attachments', data: { state, count: 2 } }) as Part
    const { rerender } = render(
      <ResearchSection parts={[attachments('running')]} live />
    )
    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Reading 2 attachments')
    expect(row).toHaveTextContent('In progress')

    rerender(
      <ResearchSection parts={[attachments('done'), RUNNING_SEARCH]} live />
    )
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Done')
  })

  it('stays expanded while live even when the header is tapped', () => {
    render(<ResearchSection parts={[RUNNING_SEARCH]} live />)
    fireEvent.click(screen.getByRole('button', { name: /Researching…/ }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('collapses when the research finishes', () => {
    const { rerender } = render(
      <ResearchSection parts={[RUNNING_SEARCH]} live />
    )
    fireEvent.click(screen.getByRole('button', { name: /Researching…/ }))
    rerender(<ResearchSection parts={[DONE_SEARCH]} live={false} />)
    expect(
      screen.getByRole('button', { name: /Completed 1 step$/ })
    ).toHaveAttribute('aria-expanded', 'false')
  })
})
