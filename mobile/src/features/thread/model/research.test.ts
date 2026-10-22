import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  describeResearchStep,
  researchSummary,
  titleOf
} from '@/features/thread/model/research'

type Part = UIMessage['parts'][number]

const asPart = (p: unknown) => p as Part

/** The same tool call, as it streams live and as a reloaded dynamic-tool. */
function bothShapes(
  toolName: string,
  rest: Record<string, unknown>
): [string, Part][] {
  return [
    ['live', asPart({ type: `tool-${toolName}`, toolCallId: 't', ...rest })],
    [
      'reloaded',
      asPart({ type: 'dynamic-tool', toolName, toolCallId: 't', ...rest })
    ]
  ]
}

describe('describeResearchStep: search', () => {
  it.each(
    bothShapes('search', {
      state: 'output-available',
      input: { query: 'tides in Hue' },
      output: {
        state: 'complete',
        query: 'tides in Hue',
        images: [],
        results: [
          { title: 'a', url: 'https://a.test', content: '' },
          { title: 'b', url: 'https://b.test', content: '' },
          { title: 'c', url: 'https://c.test', content: '' }
        ]
      }
    })
  )('labels a %s search with its query and result count', (_s, part) => {
    expect(describeResearchStep(part)).toEqual({
      kind: 'search',
      label: 'tides in Hue',
      detail: '3 results',
      done: true
    })
  })

  it.each(
    bothShapes('search', {
      state: 'output-available',
      input: { query: 'one' },
      output: { state: 'complete', query: 'one', images: [], results: [{}] }
    })
  )('says "1 result" for a single %s hit', (_s, part) => {
    expect(describeResearchStep(part)?.detail).toBe('1 result')
  })

  it.each(bothShapes('search', { state: 'input-streaming' }))(
    'falls back to "Searching" for a %s search with no input yet',
    (_s, part) => {
      expect(describeResearchStep(part)).toEqual({
        kind: 'search',
        label: 'Searching',
        done: false
      })
    }
  )

  it.each(
    bothShapes('search', {
      state: 'output-available',
      preliminary: true,
      input: { query: 'q' },
      output: { state: 'searching', query: 'q' }
    })
  )(
    'is not done while a %s search only has its preliminary "searching" output',
    (_s, part) => {
      expect(describeResearchStep(part)).toEqual({
        kind: 'search',
        label: 'q',
        done: false
      })
    }
  )

  it.each(
    bothShapes('search', {
      state: 'output-error',
      input: { query: 'q' },
      errorText: 'boom'
    })
  )('is done (without a count) when a %s search errored', (_s, part) => {
    expect(describeResearchStep(part)).toEqual({
      kind: 'search',
      label: 'q',
      done: true
    })
  })
})

describe('describeResearchStep: fetch', () => {
  it.each(
    bothShapes('fetch', {
      state: 'output-available',
      input: { url: 'https://www.example.com/a/b?c=1' },
      output: { state: 'complete', query: '', images: [], results: [] }
    })
  )('labels a %s fetch with the page hostname', (_s, part) => {
    expect(describeResearchStep(part)).toEqual({
      kind: 'fetch',
      label: 'example.com',
      done: true
    })
  })

  it.each(
    bothShapes('fetch', {
      state: 'input-available',
      input: { url: ['https://a.test/x', 'https://b.test/y', 'https://c.test'] }
    })
  )(
    'labels a batched %s fetch by its first url and counts the rest',
    (_s, part) => {
      expect(describeResearchStep(part)).toEqual({
        kind: 'fetch',
        label: 'a.test',
        detail: '+2 more',
        done: false
      })
    }
  )

  it.each(
    bothShapes('fetch', {
      state: 'output-available',
      input: { url: 'https://a.test' },
      output: { state: 'fetching', url: 'https://a.test' }
    })
  )('is not done while a %s fetch is still "fetching"', (_s, part) => {
    expect(describeResearchStep(part)?.done).toBe(false)
  })

  it.each(
    bothShapes('fetch', {
      state: 'input-available',
      input: { url: 'not a url' }
    })
  )('shows the raw text when a %s fetch url does not parse', (_s, part) => {
    expect(describeResearchStep(part)?.label).toBe('not a url')
  })

  it.each(bothShapes('fetch', { state: 'input-streaming' }))(
    'falls back to "Reading a page" for a %s fetch with no url yet',
    (_s, part) => {
      expect(describeResearchStep(part)).toEqual({
        kind: 'fetch',
        label: 'Reading a page',
        done: false
      })
    }
  )
})

describe('describeResearchStep: documentRetrieval', () => {
  it.each(
    bothShapes('documentRetrieval', {
      state: 'output-available',
      input: {},
      output: { results: [] }
    })
  )('labels a %s document retrieval', (_s, part) => {
    expect(describeResearchStep(part)).toEqual({
      kind: 'documents',
      label: 'Reading your documents',
      done: true
    })
  })
})

describe('describeResearchStep: other tools', () => {
  it.each(
    bothShapes('calculate', {
      state: 'input-available',
      input: { expression: '1+1' }
    })
  )('labels a %s tool by its name', (_s, part) => {
    expect(describeResearchStep(part)).toEqual({
      kind: 'tool',
      label: 'calculate',
      done: false
    })
  })
})

describe('describeResearchStep: reasoning', () => {
  it('is always done and previews the first 140 characters', () => {
    const text = 'x'.repeat(200)
    expect(
      describeResearchStep(
        asPart({ type: 'reasoning', text, state: 'streaming' })
      )
    ).toEqual({
      kind: 'reasoning',
      label: 'Thinking',
      detail: 'x'.repeat(140),
      done: true
    })
  })

  it('has no detail when the reasoning is empty', () => {
    expect(
      describeResearchStep(asPart({ type: 'reasoning', text: '  ' }))
    ).toEqual({ kind: 'reasoning', label: 'Thinking', done: true })
  })
})

describe('describeResearchStep: classifier', () => {
  it('is done once the classifier reports done', () => {
    expect(
      describeResearchStep(
        asPart({
          type: 'data-classifier',
          data: { state: 'done', skipSearch: true }
        })
      )
    ).toEqual({
      kind: 'classify',
      label: 'Understanding the question',
      done: true
    })
  })

  it('is not done while the classifier runs', () => {
    expect(
      describeResearchStep(
        asPart({ type: 'data-classifier', data: { state: 'running' } })
      )?.done
    ).toBe(false)
  })
})

describe('describeResearchStep: recall', () => {
  it.each([
    [1, 'Recalled 1 chat'],
    [2, 'Recalled 2 chats']
  ])('counts %i recalled chat(s)', (n, label) => {
    const chats = Array.from({ length: n }, (_, i) => ({
      chatId: `c${i}`,
      title: `t${i}`
    }))
    expect(
      describeResearchStep(asPart({ type: 'data-recall', data: { chats } }))
    ).toEqual({ kind: 'recall', label, done: true })
  })

  it('shows nothing for an empty recall', () => {
    expect(
      describeResearchStep(asPart({ type: 'data-recall', data: { chats: [] } }))
    ).toBeNull()
  })
})

describe('describeResearchStep: attachments', () => {
  it.each([
    [1, 'Reading 1 attachment'],
    [2, 'Reading 2 attachments']
  ])('reads %i attachment(s)', (count, label) => {
    expect(
      describeResearchStep(
        asPart({ type: 'data-attachments', data: { state: 'running', count } })
      )
    ).toEqual({ kind: 'attachments', label, done: false })
  })

  it('is done once the attachments are read', () => {
    expect(
      describeResearchStep(
        asPart({ type: 'data-attachments', data: { state: 'done', count: 2 } })
      )
    ).toEqual({
      kind: 'attachments',
      label: 'Reading 2 attachments',
      done: true
    })
  })

  it('reads attachments without a count', () => {
    expect(describeResearchStep(asPart({ type: 'data-attachments' }))).toEqual({
      kind: 'attachments',
      label: 'Reading attachments',
      done: false
    })
  })
})

describe('describeResearchStep: parts it does not show', () => {
  it.each([
    ['text', { type: 'text', text: 'hi' }],
    ['step-start', { type: 'step-start' }],
    ['data-title', { type: 'data-title', data: { title: 'T' } }],
    [
      'live generated image',
      {
        type: 'tool-generateImage',
        toolCallId: 'g',
        state: 'input-available',
        input: {}
      }
    ],
    [
      'reloaded generated image',
      {
        type: 'dynamic-tool',
        toolName: 'generateImage',
        toolCallId: 'g',
        state: 'input-available',
        input: {}
      }
    ]
  ])('returns null for %s', (_name, part) => {
    expect(describeResearchStep(asPart(part))).toBeNull()
  })
})

describe('researchSummary', () => {
  const search = asPart({
    type: 'tool-search',
    toolCallId: 's',
    state: 'input-available',
    input: { query: 'q' }
  })
  const reasoning = asPart({ type: 'reasoning', text: 'hmm' })
  const classifier = asPart({
    type: 'data-classifier',
    data: { state: 'running' }
  })
  const attachments = asPart({
    type: 'data-attachments',
    data: { state: 'done', count: 1 }
  })

  it('says it is researching while live', () => {
    expect(researchSummary([search], true)).toBe('Researching…')
  })

  it('counts a single step', () => {
    expect(researchSummary([search], false)).toBe('Completed 1 step')
  })

  it('counts several steps', () => {
    expect(researchSummary([search, reasoning, classifier], false)).toBe(
      'Completed 3 steps'
    )
  })

  it('counts reading attachments as a step', () => {
    expect(researchSummary([search, attachments, reasoning], false)).toBe(
      'Completed 3 steps'
    )
  })

  it('skips parts that are not shown as steps', () => {
    const title = asPart({ type: 'data-title', data: { title: 'T' } })
    expect(researchSummary([search, title, reasoning], false)).toBe(
      'Completed 2 steps'
    )
  })
})

describe('titleOf', () => {
  const message = (parts: unknown[]): UIMessage => ({
    id: 'm',
    role: 'assistant',
    parts: parts as Part[]
  })

  it('takes the last data-title part', () => {
    expect(
      titleOf(
        message([
          { type: 'data-title', data: { title: 'First' } },
          { type: 'text', text: '## A' },
          { type: 'data-title', data: { title: 'Second' } }
        ])
      )
    ).toBe('Second')
  })

  it('is undefined when there is no data-title part', () => {
    expect(titleOf(message([{ type: 'text', text: '## A' }]))).toBeUndefined()
  })
})
