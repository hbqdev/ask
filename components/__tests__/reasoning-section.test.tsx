import React from 'react'

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ReasoningSection } from '../reasoning-section'

// Mock the artifact context so the inspector-open handler has a no-op `open`.
vi.mock('@/components/artifact/artifact-context', () => ({
  useArtifact: () => ({ open: vi.fn() })
}))

// Render the reasoning body verbatim so a test can assert whether the RAW
// chain-of-thought reached the DOM.
vi.mock('../message', () => ({
  MarkdownMessage: ({ message }: { message: string }) => (
    <div data-testid="markdown-body">{message}</div>
  )
}))

// The legacy ("flag on") path wraps the body in CollapsibleMessage — render its
// header + children unconditionally so the raw text is present when shown.
vi.mock('../collapsible-message', () => ({
  CollapsibleMessage: ({
    header,
    children
  }: {
    header: React.ReactNode
    children: React.ReactNode
  }) => (
    <div data-testid="collapsible">
      {header}
      {children}
    </div>
  )
}))

const RAW_THOUGHTS =
  'Step 1: decompose the question. Step 2: SECRET-INTERNAL-CHAIN-OF-THOUGHT. Step 3: conclude.'

describe('ReasoningSection reasoning visibility flag', () => {
  const original = process.env.NEXT_PUBLIC_SHOW_REASONING
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SHOW_REASONING
    else process.env.NEXT_PUBLIC_SHOW_REASONING = original
  })

  test('hides raw reasoning text by default (flag unset), shows only a compact indicator', () => {
    delete process.env.NEXT_PUBLIC_SHOW_REASONING

    render(
      <ReasoningSection
        content={{ reasoning: RAW_THOUGHTS, isDone: true }}
        isOpen={true}
        onOpenChange={() => {}}
      />
    )

    // The raw chain-of-thought must NOT reach the DOM.
    expect(screen.queryByTestId('markdown-body')).not.toBeInTheDocument()
    expect(screen.queryByText(/SECRET-INTERNAL-CHAIN-OF-THOUGHT/)).toBeNull()
    // No collapsible/disclosure that could reveal it inline.
    expect(screen.queryByTestId('collapsible')).not.toBeInTheDocument()
    // Only the compact static label is shown when done.
    expect(screen.getByText('Thought')).toBeInTheDocument()
  })

  test('shows a compact "Thinking…" indicator while streaming (flag off), never the raw text', () => {
    delete process.env.NEXT_PUBLIC_SHOW_REASONING

    render(
      <ReasoningSection
        content={{ reasoning: RAW_THOUGHTS, isDone: false }}
        isOpen={true}
        onOpenChange={() => {}}
      />
    )

    expect(screen.queryByTestId('markdown-body')).not.toBeInTheDocument()
    expect(screen.queryByText(/SECRET-INTERNAL-CHAIN-OF-THOUGHT/)).toBeNull()
    expect(screen.getByText('Thinking…')).toBeInTheDocument()
  })

  test('restores the raw collapsible reasoning when the flag is on', () => {
    process.env.NEXT_PUBLIC_SHOW_REASONING = 'true'

    render(
      <ReasoningSection
        content={{ reasoning: RAW_THOUGHTS, isDone: true }}
        isOpen={true}
        onOpenChange={() => {}}
      />
    )

    // Legacy behavior: the raw chain-of-thought renders in the collapsible body.
    expect(screen.getByTestId('collapsible')).toBeInTheDocument()
    expect(screen.getByTestId('markdown-body')).toHaveTextContent(
      'SECRET-INTERNAL-CHAIN-OF-THOUGHT'
    )
  })
})
