import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { endsInActiveResearch, RenderMessage } from '../render-message'

vi.mock('../answer-section', () => ({
  AnswerSection: ({ content }: { content: string }) => (
    <div data-testid="answer-section">{content}</div>
  )
}))

vi.mock('../research-process-section', () => ({
  __esModule: true,
  default: ({ parts }: { parts: Array<{ type: string }> }) => (
    <div data-testid="research-process">
      {parts.map(part => part.type).join(',')}
    </div>
  )
}))

vi.mock('../dynamic-tool-display', () => ({
  DynamicToolDisplay: () => <div data-testid="dynamic-tool" />
}))

vi.mock('../user-file-section', () => ({
  UserFileSection: () => <div data-testid="user-file" />
}))

vi.mock('../user-text-section', () => ({
  UserTextSection: () => <div data-testid="user-text" />
}))

describe('RenderMessage', () => {
  const recallPart = {
    type: 'data-recall',
    id: 'recall',
    data: { chats: [{ chatId: 'past-1', title: 'Tokio vs async-std' }] }
  } as any

  test('renders recall chips above the research process, not inside it', () => {
    // The chips exist to make auto-injected memory inspectable rather than
    // spooky. Buffering them into the research process buried them in an
    // accordion that is collapsed by default, so attribution was invisible
    // unless the user expanded it. They must render as their own element,
    // ahead of the process section and the answer.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'data-classifier', data: { state: 'done' } } as any,
        recallPart,
        { type: 'reasoning', text: 'Thinking' } as any,
        { type: 'text', text: '## Final answer' } as any
      ]
    } as UIMessage

    const { container } = render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
      />
    )

    // Not swallowed by the collapsed process section.
    expect(screen.getByTestId('research-process')).toHaveTextContent(
      'data-classifier,reasoning'
    )
    expect(screen.getByTestId('research-process')).not.toHaveTextContent(
      'data-recall'
    )

    // Visible on its own, above everything.
    expect(screen.getByText('Recalled from:')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Tokio vs async-std' })
    expect(link).toHaveAttribute('href', '/search/past-1')

    const order = Array.from(
      container.querySelectorAll(
        'a[href^="/search/"], [data-testid="research-process"], [data-testid="answer-section"]'
      )
    ).map(
      node =>
        node.getAttribute('data-testid') ??
        `recall-link:${node.getAttribute('href')}`
    )
    expect(order).toEqual([
      'recall-link:/search/past-1',
      'research-process',
      'answer-section'
    ])
  })

  test('hides recall chips while research is still in progress', () => {
    // While the live indicator runs it should be the only visible activity
    // for the turn — the chips appear together with the answer, where the
    // attribution actually matters.
    const researching: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        recallPart,
        { type: 'data-classifier', data: { state: 'done' } } as any,
        {
          type: 'tool-search',
          toolCallId: 't1',
          state: 'input-available'
        } as any
      ]
    } as UIMessage

    const { rerender } = render(
      <RenderMessage
        message={researching}
        messageId={researching.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
        status="streaming"
        isLatestMessage={true}
      />
    )
    expect(screen.queryByText('Recalled from:')).not.toBeInTheDocument()

    // The answer begins: attribution appears with it.
    const answering = {
      ...researching,
      parts: [
        ...(researching.parts as any[]),
        { type: 'text', text: '## Answer' }
      ]
    } as UIMessage
    rerender(
      <RenderMessage
        message={answering}
        messageId={answering.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
        status="streaming"
        isLatestMessage={true}
      />
    )
    expect(screen.getByText('Recalled from:')).toBeInTheDocument()
  })

  test('renders no recall chips when recall injected nothing', () => {
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'data-recall', id: 'recall', data: { chats: [] } } as any,
        { type: 'text', text: '## Final answer' } as any
      ]
    } as UIMessage

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
      />
    )
    expect(screen.queryByText('Recalled from:')).not.toBeInTheDocument()
  })

  test('ignores empty text parts so research process is not split early', () => {
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'First reasoning' } as any,
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: '' } as any,
        { type: 'reasoning', text: 'Second reasoning' } as any,
        { type: 'text', text: 'Final answer' } as any
      ]
    } as UIMessage

    const { container } = render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
      />
    )

    const processSections = screen.getAllByTestId('research-process')
    expect(processSections).toHaveLength(1)
    expect(processSections[0]).toHaveTextContent(
      'reasoning,tool-search,reasoning'
    )

    const answerSections = screen.getAllByTestId('answer-section')
    expect(answerSections).toHaveLength(1)
    expect(answerSections[0]).toHaveTextContent('Final answer')

    const order = Array.from(
      container.querySelectorAll(
        '[data-testid="research-process"], [data-testid="answer-section"]'
      )
    ).map(node => node.getAttribute('data-testid'))
    expect(order).toEqual(['research-process', 'answer-section'])
  })

  test('collapses narration between many tool rounds into a single research process', () => {
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Round 1 reasoning' } as any,
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: 'Let me start researching.' } as any,
        { type: 'reasoning', text: 'Round 2 reasoning' } as any,
        {
          type: 'tool-search',
          toolCallId: 'tool-2',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: 'I have a good initial overview.' } as any,
        {
          type: 'tool-fetch',
          toolCallId: 'tool-3',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: 'Final answer' } as any
      ]
    } as UIMessage

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
      />
    )

    const processSections = screen.getAllByTestId('research-process')
    expect(processSections).toHaveLength(1)
    expect(processSections[0]).toHaveTextContent(
      'reasoning,tool-search,reasoning,tool-search,tool-fetch'
    )

    const answerSections = screen.getAllByTestId('answer-section')
    expect(answerSections).toHaveLength(1)
    expect(answerSections[0]).toHaveTextContent('Final answer')
    expect(screen.queryByText('Let me start researching.')).toBeNull()
    expect(screen.queryByText('I have a good initial overview.')).toBeNull()
  })

  test('mutes interim narration during active streaming even though nothing has followed it yet', () => {
    // While still streaming, "is this the last text part" can't tell real
    // final content apart from narration a tool call is about to follow —
    // nothing has followed it *yet* because streaming hasn't caught up.
    // This narration chunk is currently the last part in the array, but it
    // doesn't start with a heading, so it must stay muted rather than
    // flash on screen before the next tool round arrives.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Reasoning' } as any,
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: 'Let me try a different search approach.' } as any
      ]
    } as UIMessage

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
        status="streaming"
        isLatestMessage={true}
      />
    )

    expect(screen.queryByTestId('answer-section')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Let me try a different search approach.')
    ).toBeNull()
    expect(screen.getByTestId('research-process')).toHaveTextContent(
      'reasoning,tool-search'
    )
  })

  test('renders the real final answer live once it starts with a heading, even mid-stream', () => {
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Reasoning' } as any,
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: '## Report\n\nGrowing live content...' } as any
      ]
    } as UIMessage

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
        status="streaming"
        isLatestMessage={true}
      />
    )

    expect(screen.getByTestId('answer-section')).toHaveTextContent('## Report')
  })

  test('renders a completed prior answer without a heading even while a newer turn streams', () => {
    // Regression for the "double search" UI bug. `status` is the single
    // global chat status, so it reads "streaming" for EVERY rendered message
    // while any turn generates. A previous, already-finished answer that does
    // not begin with a markdown heading (common for short diagnostic replies)
    // must still render — it is not the message being streamed
    // (isLatestMessage is false), so the first-token heading gate must not
    // apply to it and its text must not vanish behind the research process.
    const message: UIMessage = {
      id: 'old-assistant-msg',
      role: 'assistant',
      parts: [
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        { type: 'text', text: 'Port 22 appears free right now.' } as any
      ]
    } as UIMessage

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
        status="streaming"
        isLatestMessage={false}
      />
    )

    expect(screen.getByTestId('answer-section')).toHaveTextContent(
      'Port 22 appears free right now.'
    )
  })
})

describe('endsInActiveResearch', () => {
  // Only one Wild Breath mark may animate at a time: while the research
  // indicator is live in the process-section header, the big footer glyph
  // must yield. These cases mirror the segmentation rules in RenderMessage.
  const msg = (parts: any[]): UIMessage =>
    ({ id: 'm', role: 'assistant', parts }) as UIMessage

  test('true while parts end in research activity with no answer yet', () => {
    expect(
      endsInActiveResearch(
        msg([
          { type: 'data-classifier', data: {} },
          { type: 'tool-search', toolCallId: 't1', state: 'input-available' }
        ])
      )
    ).toBe(true)
  })

  test('interim narration does not end the research phase', () => {
    // Non-heading text is process chatter (First-token rule): the research
    // section stays in progress through it, so the footer glyph stays hidden.
    expect(
      endsInActiveResearch(
        msg([
          { type: 'tool-search', toolCallId: 't1', state: 'output-available' },
          { type: 'text', text: 'Let me dig deeper...' }
        ])
      )
    ).toBe(true)
  })

  test('false once the final answer (heading text) streams', () => {
    expect(
      endsInActiveResearch(
        msg([
          { type: 'tool-search', toolCallId: 't1', state: 'output-available' },
          { type: 'text', text: '## James Webb updates' }
        ])
      )
    ).toBe(false)
  })

  test('true again when a new research round follows an answer', () => {
    expect(
      endsInActiveResearch(
        msg([
          { type: 'tool-search', toolCallId: 't1', state: 'output-available' },
          { type: 'text', text: '## First answer' },
          { type: 'tool-search', toolCallId: 't2', state: 'input-available' }
        ])
      )
    ).toBe(true)
  })

  test('false with no parts or with a direct text-only answer', () => {
    expect(endsInActiveResearch(msg([]))).toBe(false)
    expect(endsInActiveResearch(msg([{ type: 'text', text: 'Hi!' }]))).toBe(
      false
    )
  })
})
