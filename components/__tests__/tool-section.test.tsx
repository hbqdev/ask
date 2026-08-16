import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ToolPart } from '@/lib/types/ai'

import { ToolSection } from '../tool-section'

// Task 5 injects a synthetic `tool-documentRetrieval` part whose output carries
// the same { results: [{ title, url, content }] } shape as search/fetch. Task 7
// renders it through the shared "Sources" grid (SearchResults) so the retrieved
// document/URL cards show up under the answer.
describe('ToolSection — tool-documentRetrieval', () => {
  const part = {
    type: 'tool-documentRetrieval',
    toolCallId: 'call-doc-1',
    state: 'output-available',
    input: { query: 'attached document' },
    output: {
      state: 'complete',
      query: 'attached document',
      images: [],
      results: [
        {
          title: 'My Attached Doc',
          url: 'https://example.com/doc#chunk-1',
          content: 'the first excerpt'
        }
      ]
    }
  } as unknown as ToolPart

  it('renders the retrieved results as a Sources card', () => {
    render(<ToolSection tool={part} isOpen={true} onOpenChange={() => {}} />)

    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByText('My Attached Doc')).toBeInTheDocument()
  })

  it('renders nothing when there are no results', () => {
    const empty = {
      ...part,
      output: { state: 'complete', query: '', images: [], results: [] }
    } as unknown as ToolPart

    const { container } = render(
      <ToolSection tool={empty} isOpen={true} onOpenChange={() => {}} />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
