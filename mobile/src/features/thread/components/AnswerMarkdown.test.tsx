import { Browser } from '@capacitor/browser'
import type { UIMessage } from 'ai'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnswerMarkdown } from '@/features/thread/components/AnswerMarkdown'
import {
  listSources,
  renderableAnswer
} from '@/features/thread/model/citations'
import { extractCitationMaps } from '@/lib/utils/citation'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

type Result = { title: string; url: string; content: string }

function searchMessage(results: Result[]): UIMessage {
  return {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-search',
        toolCallId: 'call_a',
        state: 'output-available',
        input: { query: 'q' },
        output: { state: 'complete', query: 'q', images: [], results }
      }
    ]
  } as UIMessage
}

const PAGE: Result = {
  title: 'Page A',
  url: 'https://example.com/a',
  content: 'About A'
}
// A bare origin: rehype-harden writes its href back as https://example.org/.
const ORIGIN: Result = {
  title: 'Example Org',
  url: 'https://example.org',
  content: 'The org'
}

const message = searchMessage([PAGE, ORIGIN])
const maps = extractCitationMaps(message)
const sources = listSources(message)

/** The answer as the thread hands it over: citations resolved by the model layer. */
function answer(text: string, streaming = false) {
  return render(
    <AnswerMarkdown
      text={renderableAnswer(text, maps)}
      sources={sources}
      streaming={streaming}
    />
  )
}

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('AnswerMarkdown', () => {
  it('renders markdown through the real renderer', async () => {
    answer('## Heading\n\nSome **bold** text.')
    expect(
      await screen.findByRole('heading', { name: 'Heading' })
    ).toBeInTheDocument()
    expect(screen.getByText('bold')).toHaveAttribute(
      'data-streamdown',
      'strong'
    )
  })

  it('sits in .answer-prose, which keeps the answer selectable', async () => {
    answer('Some **bold** text.')
    expect(
      (await screen.findByText('bold')).closest('.answer-prose')
    ).not.toBeNull()
  })

  it('renders a citation link as a chip, not a plain anchor', async () => {
    answer('Fact [1](#call_a).')
    const chip = await screen.findByRole('button', { name: /example\.com/ })
    expect(chip).toHaveAttribute('data-citation', 'https://example.com/a')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders a citation to a bare origin as a chip', async () => {
    answer('Fact [2](#call_a).')
    const chip = await screen.findByRole('button', { name: /example\.org/ })
    expect(chip).toHaveAttribute('data-citation', 'https://example.org')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders a chip while streaming too', async () => {
    answer('## A\n\nFact [1](#call_a).', true)
    expect(
      await screen.findByRole('button', { name: /example\.com/ })
    ).toBeInTheDocument()
  })

  it('keeps a prose link to a source as a link', async () => {
    answer('Read [the full write-up](https://example.com/a).')
    const link = await screen.findByRole('link', {
      name: 'the full write-up'
    })
    fireEvent.click(link)
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://example.com/a'
    })
  })

  it('keeps a link to a source whose label has markup as a link', async () => {
    answer('See [the *full* story](https://example.com/a).')
    expect(
      await screen.findByRole('link', { name: 'the full story' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('opens a plain link in the in-app browser, not the web view', async () => {
    answer('See [the docs](https://docs.test.invalid/guide).')
    const link = await screen.findByRole('link', { name: 'the docs' })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://docs.test.invalid/guide'
    })
    expect(link).not.toHaveAttribute('target')
  })

  it('shows a link the renderer blocked as text', async () => {
    answer('Click [here](javascript:alert(1)) now.')
    const para = await screen.findByText(/Click/)
    expect(within(para).queryByRole('link')).not.toBeInTheDocument()
    expect(para).toHaveTextContent('here')
  })

  it('renders a markdown image as a link, never an img', async () => {
    const { container } = answer(
      '![a chart](https://img.test.invalid/pixel.png)'
    )
    const link = await screen.findByRole('link', { name: 'a chart' })
    expect(container.querySelector('img')).toBeNull()
    fireEvent.click(link)
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://img.test.invalid/pixel.png'
    })
  })

  it('labels an image link with its URL when it has no alt text', async () => {
    const { container } = answer('![](https://img.test.invalid/p.png)')
    expect(
      await screen.findByRole('link', {
        name: 'https://img.test.invalid/p.png'
      })
    ).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('shows an image with no usable URL as its alt text', async () => {
    const { container } = answer(
      'Before ![a diagram](/local/diagram.png) after'
    )
    const para = await screen.findByText(/Before/)
    expect(para).toHaveTextContent('a diagram')
    expect(within(para).queryByRole('link')).not.toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })

  it('names an image with neither alt text nor a usable URL', async () => {
    answer('Before ![](/local/diagram.png) after')
    expect(await screen.findByText(/Before/)).toHaveTextContent(
      'Before image after'
    )
  })

  it('shows a link with a scheme the in-app browser cannot open as text', async () => {
    answer('Write to [the team](mailto:team@test.invalid) today.')
    const para = await screen.findByText(/Write to/)
    expect(para).toHaveTextContent('Write to the team today.')
    expect(within(para).queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders math with KaTeX', async () => {
    const { container } = answer('Area is $$x^2$$ here.')
    await screen.findByText(/Area is/)
    expect(container.querySelector('.katex')).not.toBeNull()
  })

  it('leaves single-dollar text alone, as the web does', async () => {
    const { container } = answer('It costs $5 and $10.')
    expect(await screen.findByText('It costs $5 and $10.')).toBeInTheDocument()
    expect(container.querySelector('.katex')).toBeNull()
  })
})
