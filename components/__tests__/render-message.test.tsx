import React from 'react'

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { endsInActiveResearch, RenderMessage } from '../render-message'

vi.mock('../answer-section', () => ({
  AnswerSection: ({
    content,
    spokenGist,
    voiceAutoPlay
  }: {
    content: string
    spokenGist?: string
    voiceAutoPlay?: boolean
  }) => (
    <div
      data-testid="answer-section"
      data-spoken-gist={spokenGist ?? ''}
      data-voice-autoplay={String(!!voiceAutoPlay)}
    >
      {content}
    </div>
  )
}))

// Stub the real SpeakButton (which pulls in the audio hook) — these tests only
// assert that the voice block is mounted/gated correctly, not playback.
vi.mock('../voice/speak-button', () => ({
  SpeakButton: ({
    gistText,
    autoPlay
  }: {
    gistText: string
    autoPlay: boolean
  }) => (
    <div
      data-testid="speak-button"
      data-gist={gistText}
      data-autoplay={String(autoPlay)}
    />
  )
}))

vi.mock('../research-process-section', () => ({
  __esModule: true,
  default: ({
    parts,
    hasSubsequentText
  }: {
    parts: Array<{ type: string }>
    hasSubsequentText?: boolean
  }) => (
    // hasSubsequentText is what gates the section's live indicator (and with
    // it the elapsed timer and waiting quote), so the mock has to surface it.
    <div
      data-testid="research-process"
      data-has-subsequent-text={String(Boolean(hasSubsequentText))}
    >
      {parts.map(part => part.type).join(',')}
    </div>
  )
}))

vi.mock('../dynamic-tool-display', () => ({
  DynamicToolDisplay: () => <div data-testid="dynamic-tool" />
}))

vi.mock('../generated-image-section', () => ({
  GeneratedImageSection: () => <div data-testid="generated-image" />
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

  test('buffers recall into the research process, in stream order', () => {
    // The chips used to render standalone above the process, but that put an
    // extra row between the research indicator and the answer. They now ride
    // inside the process section as one of its steps — attribution stays
    // findable under "Completed N steps" without cluttering the answer view.
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

    render(
      <RenderMessage
        message={message}
        messageId={message.id}
        getIsOpen={() => true}
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByTestId('research-process')).toHaveTextContent(
      'data-classifier,data-recall,reasoning'
    )
    // No standalone chips row outside the process section.
    expect(screen.queryByText('Recalled from:')).not.toBeInTheDocument()
  })

  test('drops empty recall parts instead of buffering a blank step', () => {
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
    // Nothing recalled → no process section and no chips at all.
    expect(screen.queryByTestId('research-process')).not.toBeInTheDocument()
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

  test('renders a generated image as a standalone sibling, not inside the research process', () => {
    // Generated images are answer content: the tool-search step still belongs
    // in the collapsed research process, but the tool-generateImage part must
    // carve out into its own card rather than being buffered into the accordion.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        {
          type: 'tool-generateImage',
          toolCallId: 'tool-2',
          state: 'output-available',
          input: { prompt: 'a red fox' },
          output: {
            imageUrl: '/uploads/u/fox.png',
            modelId: 'flux',
            prompt: 'a red fox'
          }
        } as any,
        { type: 'text', text: '## Here is your image' } as any
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

    // The research process contains ONLY the search step — not the image tool.
    const processSections = screen.getAllByTestId('research-process')
    expect(processSections).toHaveLength(1)
    expect(processSections[0]).toHaveTextContent('tool-search')
    expect(processSections[0]).not.toHaveTextContent('tool-generateImage')

    // The image renders as a standalone sibling.
    expect(screen.getByTestId('generated-image')).toBeInTheDocument()

    // Order: research process, then the image card, then the answer.
    const order = Array.from(
      container.querySelectorAll(
        '[data-testid="research-process"], [data-testid="generated-image"], [data-testid="answer-section"]'
      )
    ).map(node => node.getAttribute('data-testid'))
    expect(order).toEqual([
      'research-process',
      'generated-image',
      'answer-section'
    ])
  })

  test('leaves only the last research section in progress when the stream is split', () => {
    // A generated image or an MCP tool lands mid-stream and carves the research
    // process into several sections. Only the final one is still running: the
    // earlier ones must be marked as having subsequent content, or each renders
    // its own live indicator — two spinning glyphs, two elapsed timers counting
    // from different mount times, and two /api/quotes fetches.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        {
          type: 'tool-generateImage',
          toolCallId: 'tool-2',
          state: 'output-available',
          input: { prompt: 'a red fox' },
          output: {
            imageUrl: '/uploads/u/fox.png',
            modelId: 'flux',
            prompt: 'a red fox'
          }
        } as any,
        { type: 'reasoning', text: 'Considering the image' } as any,
        {
          type: 'dynamic-tool',
          toolName: 'mcp_thing',
          toolCallId: 'tool-3',
          state: 'output-available',
          input: {},
          output: {}
        } as any,
        {
          type: 'tool-fetch',
          toolCallId: 'tool-4',
          state: 'input-available',
          input: {}
        } as any
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

    const sections = screen.getAllByTestId('research-process')
    expect(sections).toHaveLength(3)

    const live = sections.filter(
      section => section.getAttribute('data-has-subsequent-text') === 'false'
    )
    expect(live).toHaveLength(1)
    expect(live[0]).toHaveTextContent('tool-fetch')
    expect(live[0]).toBe(sections[sections.length - 1])
  })

  test('settles the lone research section when a still-generating image follows it', () => {
    // The classic image turn — data-classifier -> tool-generateImage -> answer —
    // has a SINGLE research section that precedes the standalone image. While the
    // image is still generating (a long Replicate call) that section must stop
    // spinning; otherwise a "Working on it" box with a counting timer renders
    // beside the image skeleton — the duplicate progress box. The old
    // `slice(0, -1)` skipped the only process section and left it live.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'data-classifier', data: { intent: 'general' } } as any,
        {
          type: 'tool-generateImage',
          toolCallId: 'img-1',
          state: 'input-available', // still generating, no answer yet
          input: { prompt: 'a blue vintage car' }
        } as any
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

    const sections = screen.getAllByTestId('research-process')
    expect(sections).toHaveLength(1)
    // The lone section precedes the image, so it is finished — not live.
    expect(sections[0].getAttribute('data-has-subsequent-text')).toBe('true')
    // The image skeleton is the trailing element that owns the live state.
    expect(screen.getByTestId('generated-image')).toBeInTheDocument()
  })

  test('keeps a research section live when it is the only one and the answer has not started', () => {
    // Guard against over-correcting: a single in-progress section must keep
    // its live indicator.
    const message: UIMessage = {
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        {
          type: 'tool-search',
          toolCallId: 'tool-1',
          state: 'input-available',
          input: {}
        } as any
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

    expect(screen.getByTestId('research-process')).toHaveAttribute(
      'data-has-subsequent-text',
      'false'
    )
  })
})

describe('RenderMessage voice read-aloud', () => {
  const original = process.env.NEXT_PUBLIC_VOICE_ENABLED
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_VOICE_ENABLED
    else process.env.NEXT_PUBLIC_VOICE_ENABLED = original
  })

  const messageWithGist = (): UIMessage =>
    ({
      id: 'assistant-msg',
      role: 'assistant',
      parts: [
        { type: 'text', text: '## Final answer' } as any,
        { type: 'data-spokenGist', data: { text: 'the spoken gist' } } as any
      ]
    }) as UIMessage

  test('passes the gist + autoplay to the final answer when the flag is on', () => {
    // The Listen control now lives in the answer's action row (MessageActions),
    // so render-message hands the gist + autoplay to AnswerSection as props.
    process.env.NEXT_PUBLIC_VOICE_ENABLED = 'true'
    render(
      <RenderMessage
        message={messageWithGist()}
        messageId="assistant-msg"
        getIsOpen={() => true}
        onOpenChange={() => {}}
        isLatestMessage
        voiceMode
      />
    )
    const section = screen.getByTestId('answer-section')
    expect(section).toHaveAttribute('data-spoken-gist', 'the spoken gist')
    expect(section).toHaveAttribute('data-voice-autoplay', 'true')
  })

  test('passes no gist when the flag is off (byte-identical to today)', () => {
    delete process.env.NEXT_PUBLIC_VOICE_ENABLED
    render(
      <RenderMessage
        message={messageWithGist()}
        messageId="assistant-msg"
        getIsOpen={() => true}
        onOpenChange={() => {}}
        isLatestMessage
        voiceMode
      />
    )
    expect(screen.getByTestId('answer-section')).toHaveAttribute(
      'data-spoken-gist',
      ''
    )
  })

  test('does not auto-play a non-latest answer even with voice mode on', () => {
    // Guards against re-speaking every past answer when navigating into an old
    // chat with voice mode enabled.
    process.env.NEXT_PUBLIC_VOICE_ENABLED = 'true'
    render(
      <RenderMessage
        message={messageWithGist()}
        messageId="assistant-msg"
        getIsOpen={() => true}
        onOpenChange={() => {}}
        isLatestMessage={false}
        voiceMode
      />
    )
    expect(screen.getByTestId('answer-section')).toHaveAttribute(
      'data-voice-autoplay',
      'false'
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

  test('a trailing generated-image tool is not active research', () => {
    // The standalone image card (its skeleton) is the activity cue for image
    // generation, so tool-generateImage is excluded here — otherwise the helper
    // would report research-live while no process-section indicator renders,
    // leaving neither mark animated.
    expect(
      endsInActiveResearch(
        msg([
          {
            type: 'tool-generateImage',
            toolCallId: 't1',
            state: 'input-available',
            input: { prompt: 'a red fox' }
          }
        ])
      )
    ).toBe(false)
    // Still false once the image has resolved — it never counted as research.
    expect(
      endsInActiveResearch(
        msg([
          {
            type: 'tool-generateImage',
            toolCallId: 't2',
            state: 'output-available',
            output: { imageUrl: '/x.png', modelId: 'flux', prompt: 'a red fox' }
          }
        ])
      )
    ).toBe(false)
  })

  test('recall parts count as research activity only when non-empty', () => {
    expect(
      endsInActiveResearch(
        msg([
          {
            type: 'data-recall',
            data: { chats: [{ chatId: 'c1', title: 'Past chat' }] }
          }
        ])
      )
    ).toBe(true)
    expect(
      endsInActiveResearch(msg([{ type: 'data-recall', data: { chats: [] } }]))
    ).toBe(false)
  })
})
