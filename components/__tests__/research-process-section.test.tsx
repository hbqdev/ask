import React from 'react'

import type { ReasoningPart } from '@ai-sdk/provider-utils'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, Mock, test, vi } from 'vitest'

import type { ToolPart, UIMessage } from '@/lib/types/ai'

import { ResearchProcessSection } from '../research-process-section'

// Mock the child components
vi.mock('../reasoning-section', () => ({
  ReasoningSection: ({ content, isOpen, onOpenChange }: any) => (
    <div data-testid="reasoning-section">
      <button onClick={() => onOpenChange(!isOpen)}>
        {isOpen ? 'Close' : 'Open'} Reasoning
      </button>
      {isOpen && <div>{content.reasoning}</div>}
    </div>
  )
}))

vi.mock('../tool-section', () => ({
  ToolSection: ({ tool, isOpen, onOpenChange }: any) => (
    <div data-testid="tool-section">
      <button onClick={() => onOpenChange(!isOpen)}>
        {isOpen ? 'Close' : 'Open'} Tool
      </button>
      {isOpen && <div>{tool.type}</div>}
    </div>
  )
}))

describe('ResearchProcessSection', () => {
  const mockGetIsOpen = vi.fn()
  const mockOnOpenChange = vi.fn()
  const mockAddToolResult = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetIsOpen.mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Type Guards', () => {
    test('correctly identifies reasoning parts', () => {
      const reasoningPart: ReasoningPart = {
        type: 'reasoning',
        text: 'Test reasoning'
      }

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [reasoningPart]
      } as unknown as UIMessage

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-1"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      expect(screen.getByTestId('reasoning-section')).toBeInTheDocument()
    })

    test('correctly identifies tool parts', () => {
      const toolPart: ToolPart = {
        type: 'tool-search',
        toolCallId: 'tool-1',
        input: {},
        state: 'output-available'
      }

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [toolPart as any]
      } as UIMessage

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-2"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      expect(screen.getByTestId('tool-section')).toBeInTheDocument()
    })

    test('filters out empty reasoning parts', () => {
      const emptyReasoningPart: ReasoningPart = {
        type: 'reasoning',
        text: ''
      }

      const validReasoningPart: ReasoningPart = {
        type: 'reasoning',
        text: 'Valid reasoning'
      }

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [emptyReasoningPart, validReasoningPart]
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-3"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // Should only render one reasoning section (the valid one)
      const reasoningSections = screen.getAllByTestId('reasoning-section')
      expect(reasoningSections).toHaveLength(1)
    })
  })

  describe('Segmentation Logic', () => {
    test('splits parts by text correctly', () => {
      const parts: any[] = [
        { type: 'reasoning', text: 'First reasoning' } as ReasoningPart,
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          input: {},
          state: 'output-available'
        } as ToolPart,
        { type: 'text', text: 'Text separator' },
        { type: 'reasoning', text: 'Second reasoning' } as ReasoningPart
      ]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-4"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // Should render 3 sections (2 reasoning + 1 tool, split by text)
      const allSections = [
        ...screen.getAllByTestId('reasoning-section'),
        ...screen.getAllByTestId('tool-section')
      ]
      expect(allSections).toHaveLength(3)
    })

    test('groups consecutive tool parts of same type', () => {
      const parts: any[] = [
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          input: {},
          state: 'output-available'
        } as ToolPart,
        {
          type: 'tool-search',
          toolCallId: 'tool-2',
          input: {},
          state: 'output-available'
        } as ToolPart,
        {
          type: 'tool-fetch',
          toolCallId: 'tool-3',
          input: {},
          state: 'output-available'
        } as ToolPart
      ]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-5"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      const toolSections = screen.getAllByTestId('tool-section')
      expect(toolSections).toHaveLength(3)
    })
  })

  describe('Summary line wrapping', () => {
    test('always wraps the step list behind a single summary trigger, regardless of count', () => {
      // A single reasoning part used to render unwrapped; it must now be
      // wrapped behind a "Completed N steps" summary trigger just like a
      // larger group.
      const singlePart = [
        { type: 'reasoning', text: 'Single reasoning' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      // Parent starts open by default (no hasSubsequentText passed), so the
      // inner reasoning-section mock is also present in the DOM.
      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      expect(screen.getByText('Completed 1 step')).toBeInTheDocument()
      expect(screen.getByTestId('reasoning-section')).toBeInTheDocument()
    })

    test('shows an in-progress label while streaming with no subsequent text yet', () => {
      const singlePart = [
        { type: 'reasoning', text: 'Still thinking' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7b"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          status="streaming"
          isLatestMessage={true}
          hasSubsequentText={false}
        />
      )

      expect(
        screen.getByText('Working on it — 1 step so far')
      ).toBeInTheDocument()
    })

    test('does not show in-progress for a non-latest message while the chat is streaming', () => {
      // Regression for the "double search" UI bug. `status` is the single
      // global chat status, so it is "streaming" for every rendered message
      // while any turn generates. A previous, completed turn
      // (isLatestMessage=false) must stay "Completed N steps" — only the
      // message actually being streamed may show the in-progress label.
      const singlePart = [
        { type: 'reasoning', text: 'Old reasoning' } as ReasoningPart
      ]

      const message = {
        id: 'old-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7b-old"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          status="streaming"
          hasSubsequentText={false}
          isLatestMessage={false}
        />
      )

      expect(screen.getByText('Completed 1 step')).toBeInTheDocument()
      expect(
        screen.queryByText('Working on it — 1 step so far')
      ).not.toBeInTheDocument()
    })

    test('switches to "Completed N steps" once subsequent text exists', () => {
      const singlePart = [
        { type: 'reasoning', text: 'Done thinking' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7c"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          status="streaming"
          isLatestMessage={true}
          hasSubsequentText={true}
        />
      )

      expect(screen.getByText('Completed 1 step')).toBeInTheDocument()
    })

    test('peeks open for 2 seconds while in progress, then auto-collapses', () => {
      vi.useFakeTimers()

      const singlePart = [
        { type: 'reasoning', text: 'Still thinking' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7e"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          status="streaming"
          isLatestMessage={true}
          hasSubsequentText={false}
        />
      )

      // Open initially — the inner reasoning-section is visible.
      expect(screen.getByTestId('reasoning-section')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      // Auto-collapsed after the peek window — inner content unmounts
      // (Radix Collapsible unmounts its content by default when closed),
      // and the summary text retreats behind the animated indicator.
      expect(screen.queryByTestId('reasoning-section')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Working on it — 1 step so far')
      ).not.toBeInTheDocument()

      // Clicking the indicator reveals the summary text again.
      fireEvent.click(
        screen.getByRole('button', { name: 'Show research status' })
      )
      expect(
        screen.getByText('Working on it — 1 step so far')
      ).toBeInTheDocument()

      // Clicking it again fully retreats: summary hidden, steps closed.
      fireEvent.click(
        screen.getByRole('button', { name: 'Hide research status' })
      )
      expect(
        screen.queryByText('Working on it — 1 step so far')
      ).not.toBeInTheDocument()
      expect(screen.queryByTestId('reasoning-section')).not.toBeInTheDocument()

      vi.useRealTimers()
    })

    test('pluralizes the step count correctly', () => {
      const parts: any[] = [
        { type: 'reasoning', text: 'First' } as ReasoningPart,
        { type: 'reasoning', text: 'Second' } as ReasoningPart
      ]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7d"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      expect(screen.getByText('Completed 2 steps')).toBeInTheDocument()
    })
  })

  describe('Accordion Behavior', () => {
    test('handles accordion state for grouped sections', () => {
      const parts: any[] = [
        { type: 'reasoning', text: 'First' } as ReasoningPart,
        { type: 'reasoning', text: 'Second' } as ReasoningPart
      ]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      const { rerender } = render(
        <ResearchProcessSection
          message={message}
          messageId="test-6"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // Parent summary is open by default, so both inner reasoning buttons
      // are present alongside the outer summary trigger. Click the first
      // inner reasoning button (index 1 — index 0 is the summary trigger).
      const buttons = screen.getAllByRole('button')
      fireEvent.click(buttons[1])

      // Should call onOpenChange
      expect(mockOnOpenChange).toHaveBeenCalled()

      // Update mock to return true for the clicked item
      mockGetIsOpen.mockImplementation(id => id.includes('reasoning-0-0-0'))

      rerender(
        <ResearchProcessSection
          message={message}
          messageId="test-6"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )
    })

    test('clicking the summary trigger does not call onOpenChange directly', () => {
      // The outer "Completed N steps" trigger manages its own local
      // open/closed state — it must not be conflated with the per-part
      // onOpenChange callback used by individual steps.
      const singlePart = [
        { type: 'reasoning', text: 'Single reasoning' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      const summaryTrigger = screen.getByText('Completed 1 step')
      fireEvent.click(summaryTrigger)

      expect(mockOnOpenChange).not.toHaveBeenCalled()
    })

    test('clicking an inner step button still calls onOpenChange directly for single sections', () => {
      const singlePart = [
        { type: 'reasoning', text: 'Single reasoning' } as ReasoningPart
      ]

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: singlePart
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-7"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // Parent summary defaults open, so the inner reasoning-section mock's
      // button is present. Query within it specifically.
      const innerButton = within(
        screen.getByTestId('reasoning-section')
      ).getByRole('button')
      fireEvent.click(innerButton)

      // For single sections, should directly call onOpenChange
      expect(mockOnOpenChange).toHaveBeenCalledWith(
        expect.stringContaining('reasoning'),
        true
      )
    })
  })

  describe('Subsequent Content Detection', () => {
    test('detects subsequent content correctly', () => {
      const parts: any[] = [
        { type: 'reasoning', text: 'First' } as ReasoningPart,
        { type: 'text', text: 'Text' },
        { type: 'reasoning', text: 'Second' } as ReasoningPart
      ]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-8"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // The first reasoning should detect subsequent content (the text part)
      expect(mockGetIsOpen).toHaveBeenCalledWith(
        expect.stringContaining('reasoning'),
        'reasoning',
        true // hasSubsequentContent should be true
      )
    })
  })

  describe('Edge Cases', () => {
    test('returns null for empty segments', () => {
      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: []
      }

      const { container } = render(
        <ResearchProcessSection
          message={message}
          messageId="test-9"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      expect(container.firstChild).toBeNull()
    })

    test('handles parts override correctly', () => {
      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [{ type: 'reasoning', text: 'Original' } as ReasoningPart]
      }

      const overrideParts = [
        { type: 'reasoning', text: 'Override' } as ReasoningPart
      ]

      // Mock getIsOpen to return true so content is visible
      mockGetIsOpen.mockReturnValue(true)

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-10"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          parts={overrideParts}
        />
      )

      // Should use override parts
      expect(screen.getByTestId('reasoning-section')).toBeInTheDocument()
      // The content should show "Override" when open
      expect(screen.getByText('Override')).toBeInTheDocument()
    })

    test('ignores unknown part types', () => {
      const parts: any[] = [{ type: 'data-test', data: 'test' }]

      const message: UIMessage = {
        id: 'test-message',
        role: 'assistant',
        parts
      }

      const { container } = render(
        <ResearchProcessSection
          message={message}
          messageId="test-11"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
        />
      )

      // Unknown part types render no meaningful content (wrapper may exist)
      expect(screen.queryByTestId('reasoning-section')).not.toBeInTheDocument()
      expect(screen.queryByTestId('tool-section')).not.toBeInTheDocument()
    })
  })

  describe('Props Handling', () => {
    test('passes status prop correctly', () => {
      const toolPart: ToolPart = {
        type: 'tool-search',
        toolCallId: 'tool-1',
        input: {},
        state: 'output-available'
      }

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [toolPart as any]
      } as UIMessage

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-12"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          status="streaming"
        />
      )

      expect(screen.getByTestId('tool-section')).toBeInTheDocument()
    })

    test('passes addToolResult prop correctly', () => {
      const toolPart: ToolPart = {
        type: 'tool-search',
        toolCallId: 'tool-1',
        input: {},
        state: 'output-available'
      }

      const message = {
        id: 'test-message',
        role: 'assistant' as const,
        parts: [toolPart as any]
      } as UIMessage

      render(
        <ResearchProcessSection
          message={message}
          messageId="test-13"
          getIsOpen={mockGetIsOpen}
          onOpenChange={mockOnOpenChange}
          addToolResult={mockAddToolResult}
        />
      )

      expect(screen.getByTestId('tool-section')).toBeInTheDocument()
    })
  })
})
