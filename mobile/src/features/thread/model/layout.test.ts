import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  layoutAssistantMessage,
  pastTurnStyle
} from '@/features/thread/model/layout'

type Part = UIMessage['parts'][number]

function msg(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts: parts as Part[] }
}

const classifier = {
  type: 'data-classifier',
  data: { state: 'done', skipSearch: false }
}
const search = {
  type: 'tool-search',
  toolCallId: 's1',
  state: 'output-available',
  input: { query: 'q' },
  output: { state: 'complete', results: [], images: [], query: 'q' }
}
const image = {
  type: 'tool-generateImage',
  toolCallId: 'g1',
  state: 'output-available',
  input: { prompt: 'a cat' },
  output: { imageUrl: '/uploads/a.png', prompt: 'a cat' }
}

describe('layoutAssistantMessage', () => {
  it.each([false, true])(
    'groups research before a heading answer (streaming=%s)',
    streaming => {
      const blocks = layoutAssistantMessage(
        msg([classifier, search, { type: 'text', text: '## A' }]),
        streaming
      )
      expect(blocks).toEqual([
        { kind: 'research', parts: [classifier, search], live: false },
        { kind: 'answer', text: '## A' }
      ])
    }
  )

  it('drops narration while streaming and keeps the trailing research live', () => {
    const blocks = layoutAssistantMessage(
      msg([search, { type: 'text', text: 'Let me look' }]),
      true
    )
    expect(blocks).toEqual([{ kind: 'research', parts: [search], live: true }])
  })

  it('makes a generated image its own block between research and answer', () => {
    const blocks = layoutAssistantMessage(
      msg([search, image, { type: 'text', text: 'Here it is.' }]),
      false
    )
    expect(blocks).toEqual([
      { kind: 'research', parts: [search], live: false },
      { kind: 'image', part: image },
      { kind: 'answer', text: 'Here it is.' }
    ])
  })

  it('classifies reloaded dynamic-tool parts like live tool parts', () => {
    const dynImage = {
      type: 'dynamic-tool',
      toolName: 'generateImage',
      toolCallId: 'g2',
      state: 'output-available',
      input: {},
      output: { imageUrl: '/uploads/b.png', prompt: 'p' }
    }
    const dynCalc = {
      type: 'dynamic-tool',
      toolName: 'calculate',
      toolCallId: 'c1',
      state: 'output-available',
      input: {},
      output: {}
    }
    const blocks = layoutAssistantMessage(
      msg([dynCalc, dynImage, { type: 'text', text: '## Done' }]),
      false
    )
    expect(blocks).toEqual([
      { kind: 'research', parts: [dynCalc], live: false },
      { kind: 'image', part: dynImage },
      { kind: 'answer', text: '## Done' }
    ])
  })

  it('keeps only the last non-empty text part as the answer once complete', () => {
    const blocks = layoutAssistantMessage(
      msg([
        { type: 'text', text: 'Earlier' },
        search,
        { type: 'text', text: 'Final answer' },
        { type: 'text', text: '   ' }
      ]),
      false
    )
    expect(blocks).toEqual([
      { kind: 'research', parts: [search], live: false },
      { kind: 'answer', text: 'Final answer' }
    ])
  })

  it('is not live when complete even if research is the last block', () => {
    expect(layoutAssistantMessage(msg([search]), false)).toEqual([
      { kind: 'research', parts: [search], live: false }
    ])
  })

  it('skips parts that are neither research, image nor answer', () => {
    expect(
      layoutAssistantMessage(
        msg([
          { type: 'step-start' },
          { type: 'data-title', data: { title: 'T' } },
          { type: 'data-recall', data: { chats: [] } }
        ]),
        false
      )
    ).toEqual([])
  })

  it('gives no blocks for a message with no parts', () => {
    expect(layoutAssistantMessage(msg([]), false)).toEqual([])
    expect(layoutAssistantMessage(msg([]), true)).toEqual([])
  })
})

describe('pastTurnStyle', () => {
  const PAST = {
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 480px',
    // Room inside the contained (clipped) box for hit areas and focus rings
    // at its edges, the box's place in the layout unchanged.
    padding: '8px 12px',
    margin: '-8px -12px'
  }

  it('lets the browser skip laying out a past message while off screen', () => {
    expect(pastTurnStyle(0, 5)).toEqual(PAST)
    expect(pastTurnStyle(2, 5)).toEqual(PAST)
  })

  it('lays out the last two messages (the latest question and answer) always', () => {
    expect(pastTurnStyle(3, 5)).toBeUndefined()
    expect(pastTurnStyle(4, 5)).toBeUndefined()
  })

  it('skips nothing in a thread of one or two messages', () => {
    expect(pastTurnStyle(0, 1)).toBeUndefined()
    expect(pastTurnStyle(0, 2)).toBeUndefined()
    expect(pastTurnStyle(1, 2)).toBeUndefined()
  })
})
