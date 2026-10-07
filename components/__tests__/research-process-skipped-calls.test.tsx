import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { ResearchProcessSection } from '../research-process-section'

// The real ToolSection -> SearchSection / FetchSection tree, so this checks the
// rows a user actually sees. Only the artifact inspector context is stubbed
// (its provider needs the sidebar + library providers).
vi.mock('@/components/artifact/artifact-context', () => ({
  useArtifact: () => ({ open: vi.fn() })
}))

const realSearch = (id: string, query: string) => ({
  type: 'tool-search',
  toolCallId: id,
  state: 'output-available',
  input: { query },
  output: {
    state: 'complete',
    query,
    images: [],
    results: [
      { title: `Result ${id}`, url: `https://example.com/${id}`, content: 'c' }
    ],
    number_of_results: 1
  }
})

const capRefused = (id: string, query: string) => ({
  type: 'tool-search',
  toolCallId: id,
  state: 'output-available',
  input: { query },
  output: {
    state: 'complete',
    results: [],
    images: [],
    query,
    number_of_results: 0,
    searchLimitReached: true,
    notice: 'Search limit reached (3 searches this turn). Do not search again.'
  }
})

const answerNowSearch = (id: string, query: string) => ({
  type: 'tool-search',
  toolCallId: id,
  state: 'output-available',
  input: { query },
  output: {
    state: 'complete',
    results: [],
    images: [],
    query,
    number_of_results: 0,
    answerNow: true,
    notice:
      'Research time for this turn is over, so this tool call was not run.'
  }
})

const invalidInput = (id: string) => ({
  type: 'tool-search',
  toolCallId: id,
  state: 'output-error',
  input: { q: 'invented' },
  errorText: 'Invalid input for tool search: Type validation failed.'
})

const answerNowFetch = (id: string) => ({
  type: 'tool-fetch',
  toolCallId: id,
  state: 'output-available',
  input: { url: 'https://example.com/never-read' },
  output: {
    state: 'complete',
    results: [],
    images: [],
    query: '',
    answerNow: true,
    notice:
      'Research time for this turn is over, so this tool call was not run.'
  }
})

function renderTurn(parts: any[]) {
  return render(
    <ResearchProcessSection
      message={{ id: 'm', role: 'assistant', parts } as UIMessage}
      messageId="m"
      getIsOpen={() => false}
      onOpenChange={() => {}}
      parts={parts}
    />
  )
}

describe('ResearchProcessSection — refused calls, real rows', () => {
  test('the prod pattern: real searches keep their rows, every refusal is one line', () => {
    renderTurn([
      { type: 'data-classifier', data: { state: 'done', skipSearch: false } },
      realSearch('s1', 'mistral large 4 benchmarks'),
      realSearch('s2', 'mistral large 4 pricing'),
      capRefused('x1', 'mistral large 4 context window'),
      { type: 'reasoning', text: 'I should look again' },
      capRefused('x2', 'mistral large 4 release date'),
      invalidInput('e1'),
      answerNowSearch('a1', 'mistral large 4 reviews'),
      answerNowFetch('f1')
    ])

    // Real searches render as today: their query is the row label.
    expect(screen.getByText('mistral large 4 benchmarks')).toBeInTheDocument()
    expect(screen.getByText('mistral large 4 pricing')).toBeInTheDocument()

    // Refused calls are not rendered as searches (or as failed page reads).
    expect(
      screen.queryByText('mistral large 4 context window')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('mistral large 4 release date')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('mistral large 4 reviews')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('No content retrieved')).not.toBeInTheDocument()
    expect(screen.queryByText(/Invalid input/)).not.toBeInTheDocument()

    expect(
      screen.getByText(
        'Search limit reached — 4 extra searches and 1 page read skipped'
      )
    ).toBeInTheDocument()
  })
})
