import type { UIMessage } from 'ai'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  AssistantTurn,
  type AssistantTurnProps
} from '@/features/thread/components/AssistantTurn'

vi.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: vi.fn(async () => {}) }
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => ({})) }
}))
vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

type Part = UIMessage['parts'][number]

const BASE = 'https://ask.test.invalid'

// --- Fixtures ----------------------------------------------------------------

const add = (path: string, value: unknown) => ({ op: 'add', path, value })

function fence(lines: object[], closed = true): string {
  const body = ['```spec', ...lines.map(l => JSON.stringify(l))]
  return [...body, ...(closed ? ['```'] : [])].join('\n')
}

/** A spec fence of related follow-up questions, as the model writes it. */
function relatedFence(queries: string[], closed = true): string {
  const ids = queries.map((_, i) => `q${i + 1}`)
  return fence(
    [
      add('/root', 'main'),
      add('/elements/main', {
        type: 'Stack',
        props: { direction: 'vertical', gap: 'sm' },
        children: ids
      }),
      ...queries.map((query, i) =>
        add(`/elements/${ids[i]}`, {
          type: 'Button',
          props: { text: query, variant: 'link' },
          on: { press: { action: 'submitQuery', params: { query } } },
          children: []
        })
      )
    ],
    closed
  )
}

/** A spec fence with one inline image. */
function imageFence(src: string): string {
  return fence([
    add('/root', 'img1'),
    add('/elements/img1', {
      type: 'Image',
      props: { src, title: 'A photo' },
      children: []
    })
  ])
}

const searchPart = {
  type: 'tool-search',
  toolCallId: 'call_a',
  state: 'output-available',
  input: { query: 'facts' },
  output: {
    state: 'complete',
    query: 'facts',
    images: [],
    results: [{ title: 'A', url: 'https://example.com/a', content: 'a' }]
  }
} as Part

const text = (value: string) => ({ type: 'text', text: value }) as Part

const assistant = (parts: Part[]): UIMessage => ({
  id: 'a1',
  role: 'assistant',
  parts
})

const ANSWER = '## Answer\n\nThe fact [1](#call_a).'

function renderTurn(props: Partial<AssistantTurnProps> = {}) {
  const onAsk = vi.fn()
  const onRetry = vi.fn()
  const utils = render(
    <AssistantTurn
      message={assistant([
        searchPart,
        text(`${ANSWER}\n\n${relatedFence(['Why?', 'How?'])}`)
      ])}
      streaming={false}
      isLatest
      question="What is the fact?"
      onAsk={onAsk}
      onRetry={onRetry}
      baseUrl={BASE}
      {...props}
    />
  )
  return { ...utils, onAsk, onRetry }
}

// --- Tests -------------------------------------------------------------------

describe('AssistantTurn', () => {
  it('shows the answer as plain text until the renderer has loaded', async () => {
    // A fresh copy of the module, whose renderer has not loaded yet.
    vi.resetModules()
    const fresh = await import('@/features/thread/components/AssistantTurn')
    render(
      <fresh.AssistantTurn
        message={assistant([text('## Answer\n\nPlain for now.')])}
        streaming={false}
        isLatest
        question="Q"
        onAsk={vi.fn()}
        onRetry={vi.fn()}
        baseUrl={BASE}
      />
    )
    expect(screen.getByText(/## Answer\s+Plain for now\./)).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Answer' })
    ).toBeInTheDocument()
  })

  it('preloads the renderer on request', async () => {
    vi.resetModules()
    const fresh = await import('@/features/thread/components/AssistantTurn')
    await expect(fresh.preloadAnswerRenderer()).resolves.toBeUndefined()
  })

  it('shows the research, then the answer with its citation chip', async () => {
    renderTurn()
    expect(
      screen.getByRole('button', { name: /Completed 1 step/ })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: 'Answer' })
    ).toBeInTheDocument()
    expect(screen.getByText(/The fact/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /example\.com/ })).toBeVisible()
    // The spec fence is not shown as text.
    expect(screen.queryByText(/submitQuery/)).not.toBeInTheDocument()
  })

  it('shows a generated image with the API base', () => {
    renderTurn({
      message: assistant([
        {
          type: 'tool-generateImage',
          toolCallId: 'g1',
          state: 'output-available',
          input: { prompt: 'a fox' },
          output: { imageUrl: '/uploads/fox.png', prompt: 'a fox' }
        } as Part,
        text('## Done\n\nHere it is.')
      ])
    })
    expect(screen.getByRole('img', { name: 'a fox' })).toHaveAttribute(
      'src',
      `${BASE}/uploads/fox.png`
    )
  })

  it('shows the images an answer carries', () => {
    renderTurn({
      message: assistant([
        text(`${ANSWER}\n\n${imageFence('https://img.test.invalid/p.jpg')}`)
      ])
    })
    expect(screen.getByRole('img', { name: 'A photo' })).toHaveAttribute(
      'src',
      'https://img.test.invalid/p.jpg'
    )
  })

  it('offers the related questions and the actions once finished', () => {
    const { onAsk, onRetry } = renderTurn()
    const why = screen.getByRole('button', { name: 'Why?' })
    expect(why).toBeEnabled()
    fireEvent.click(why)
    expect(onAsk).toHaveBeenCalledWith('Why?')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('a1')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('hides the related questions until their fence is finished', () => {
    renderTurn({
      streaming: true,
      message: assistant([
        text(`${ANSWER}\n\n${relatedFence(['Why?'], false)}`)
      ])
    })
    expect(
      screen.queryByRole('button', { name: 'Why?' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/submitQuery/)).not.toBeInTheDocument()
  })

  it('disables the related questions and hides the actions while streaming', () => {
    renderTurn({ streaming: true })
    expect(screen.getByRole('button', { name: 'Why?' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Retry' })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Copy' })
    ).not.toBeInTheDocument()
  })

  it('shows that it is working while a streaming turn has nothing to show', () => {
    const { rerender } = renderTurn({
      streaming: true,
      message: assistant([{ type: 'step-start' } as Part])
    })
    expect(screen.getByRole('status', { name: 'Thinking' })).toBeInTheDocument()

    rerender(
      <AssistantTurn
        message={assistant([searchPart])}
        streaming
        isLatest
        question="Q"
        onAsk={vi.fn()}
        onRetry={vi.fn()}
        baseUrl={BASE}
      />
    )
    expect(
      screen.queryByRole('status', { name: 'Thinking' })
    ).not.toBeInTheDocument()
  })

  it('offers Retry for a finished turn with no answer text', () => {
    const { onRetry } = renderTurn({ message: assistant([searchPart]) })
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('a1')
  })

  it('takes related questions from the last answer only', () => {
    renderTurn({
      message: assistant([
        text(`## First\n\nOne.\n\n${relatedFence(['Old?'])}`),
        searchPart,
        text(`## Second\n\nTwo.\n\n${relatedFence(['New?'])}`)
      ])
    })
    expect(screen.getByRole('button', { name: 'New?' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Old?' })
    ).not.toBeInTheDocument()
  })

  it('lets the browser skip laying it out while off screen', () => {
    const { container } = renderTurn()
    const turn = container.firstElementChild as HTMLElement
    expect(turn.style.contentVisibility).toBe('auto')
    expect(turn.style.containIntrinsicSize).toBe('auto 600px')
  })
})
