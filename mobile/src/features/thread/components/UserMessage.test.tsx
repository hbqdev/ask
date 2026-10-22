import { Browser } from '@capacitor/browser'
import type { UIMessage } from 'ai'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attachmentUrl,
  fileTypeLabel,
  UserMessage
} from '@/features/thread/components/UserMessage'
import { clippingAncestors } from '@/test/clipping'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

const BASE = 'https://ask.test.invalid'

const message = (parts: unknown[]): UIMessage =>
  ({ id: 'u1', role: 'user', parts }) as UIMessage

const image = (name: string, url = `${BASE}/uploads/${name}?sig=1`) => ({
  type: 'file',
  url,
  filename: name,
  mediaType: 'image/png'
})

const PDF = {
  type: 'file',
  url: `${BASE}/uploads/report.pdf?sig=2`,
  filename: 'report.pdf',
  mediaType: 'application/pdf'
}

const renderMessage = (parts: unknown[], baseUrl = BASE) =>
  render(<UserMessage message={message(parts)} baseUrl={baseUrl} />)

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('attachmentUrl', () => {
  it.each([
    ['https://cdn.test.invalid/a.png', 'https://cdn.test.invalid/a.png'],
    ['http://cdn.test.invalid/a.png', 'http://cdn.test.invalid/a.png'],
    ['/uploads/u/a.png?sig=1', `${BASE}/uploads/u/a.png?sig=1`]
  ])('keeps or resolves %s', (url, expected) => {
    expect(attachmentUrl(url, BASE)).toBe(expected)
  })

  it('joins a relative upload to a base with a trailing slash', () => {
    expect(attachmentUrl('/uploads/a.png', `${BASE}/`)).toBe(
      `${BASE}/uploads/a.png`
    )
  })

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'blob:https://x/1',
    '/api/other',
    'uploads/a.png',
    '//evil.test.invalid/uploads/a.png',
    'not a url',
    ''
  ])('refuses %s', url => {
    expect(attachmentUrl(url, BASE)).toBeNull()
  })
})

describe('fileTypeLabel', () => {
  it.each([
    ['report.pdf', 'application/pdf', 'PDF'],
    ['notes.final.md', 'text/markdown', 'MD'],
    ['README', 'text/plain', 'PLAIN'],
    ['', 'application/vnd.ms-excel', 'VND.MS-EXCEL'],
    ['', '', 'File']
  ])('labels %s (%s) as %s', (name, type, label) => {
    expect(fileTypeLabel(name, type)).toBe(label)
  })
})

describe('UserMessage: text', () => {
  it('shows the question in a bubble', () => {
    renderMessage([{ type: 'text', text: 'What is this?' }])
    expect(screen.getByText('What is this?', { selector: 'p' })).toBeVisible()
  })

  it('joins several text parts', () => {
    renderMessage([
      { type: 'text', text: 'One ' },
      { type: 'text', text: 'two' }
    ])
    expect(screen.getByText('One two', { selector: 'p' })).toBeVisible()
  })

  it('renders nothing for a message with nothing to show', () => {
    const { container } = renderMessage([
      { type: 'text', text: '' },
      { type: 'data-pastedContent', data: { text: '' } },
      { type: 'step-start' }
    ])
    expect(container).toBeEmptyDOMElement()
  })
})

describe('UserMessage: images', () => {
  it('shows a single image large, from its signed URL, with no empty bubble', () => {
    const { container } = renderMessage([image('a.png')])
    const img = screen.getByRole('img', { name: 'a.png' })
    expect(img).toHaveAttribute('src', `${BASE}/uploads/a.png?sig=1`)
    expect(img).toHaveAttribute('loading', 'lazy')
    expect(img).toHaveAttribute('decoding', 'async')
    expect(screen.getByTestId('image-grid')).toHaveAttribute('data-count', '1')
    expect(container.querySelector('[data-testid="user-bubble"]')).toBeNull()
  })

  it('prefixes a relative upload URL with the API base', () => {
    renderMessage([image('b.png', '/uploads/u/b.png?sig=3')])
    expect(screen.getByRole('img', { name: 'b.png' })).toHaveAttribute(
      'src',
      `${BASE}/uploads/u/b.png?sig=3`
    )
  })

  it('shows up to four images in a grid, the fourth counting the rest', () => {
    renderMessage([
      ...['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'].map(n =>
        image(n)
      ),
      { type: 'text', text: 'Compare these' }
    ])
    const grid = screen.getByTestId('image-grid')
    expect(grid).toHaveAttribute('data-count', '4')
    expect(within(grid).getAllByRole('img')).toHaveLength(4)
    expect(within(grid).getByText('+2')).toBeVisible()
    expect(screen.getByText('Compare these', { selector: 'p' })).toBeVisible()
  })

  it('shows no count when four images fit', () => {
    renderMessage(['1.png', '2.png', '3.png', '4.png'].map(n => image(n)))
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument()
  })

  it('names an image without a filename', () => {
    renderMessage([{ ...image('a.png'), filename: undefined }])
    expect(screen.getByRole('button', { name: 'View Image' })).toBeVisible()
  })

  it('shows a placeholder for an image that fails to load', () => {
    renderMessage([image('a.png')])
    fireEvent.error(screen.getByRole('img', { name: 'a.png' }))
    expect(screen.queryByRole('img', { name: 'a.png' })).not.toBeInTheDocument()
    expect(screen.getByTestId('image-placeholder')).toBeInTheDocument()
  })

  it('renders an image with an unsafe URL as a plain chip, not an image', () => {
    renderMessage([image('x.png', 'javascript:alert(1)')])
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /x\.png/ })
    ).not.toBeInTheDocument()
    expect(screen.getByText('x.png')).toBeInTheDocument()
  })
})

describe('UserMessage: image viewer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens the tapped image full size, and closes', () => {
    renderMessage([image('1.png'), image('2.png'), image('3.png')])
    fireEvent.click(screen.getByRole('button', { name: 'View 2.png' }))

    const viewer = screen.getByRole('dialog', { name: 'Image 2 of 3' })
    // The full-screen viewer, not a sheet.
    expect(viewer).toHaveClass('fixed', 'inset-0', 'bg-black')
    expect(within(viewer).getByText('2 / 3')).toBeVisible()
    expect(within(viewer).getAllByRole('img')).toHaveLength(3)
    expect(within(viewer).getByRole('img', { name: '2.png' })).toHaveAttribute(
      'src',
      `${BASE}/uploads/2.png?sig=1`
    )

    fireEvent.click(within(viewer).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('gives focus back to the tapped image once the viewer closes', async () => {
    const user = userEvent.setup()
    renderMessage([image('1.png'), image('2.png')])
    const thumb = screen.getByRole('button', { name: 'View 2.png' })
    await user.click(thumb)
    expect(screen.getByRole('dialog')).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(thumb).toHaveFocus()
  })

  it('names a lone image without a count', () => {
    renderMessage([image('1.png')])
    fireEvent.click(screen.getByRole('button', { name: 'View 1.png' }))
    expect(screen.getByRole('dialog', { name: 'Image' })).toBeInTheDocument()
  })

  it('scrolls to the tapped image, and follows a swipe', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    renderMessage([image('1.png'), image('2.png'), image('3.png')])
    fireEvent.click(screen.getByRole('button', { name: 'View 3.png' }))

    const strip = screen.getByTestId('viewer-strip')
    expect(strip.scrollLeft).toBe(600)

    strip.scrollLeft = 290
    fireEvent.scroll(strip)
    expect(
      screen.getByRole('dialog', { name: 'Image 2 of 3' })
    ).toBeInTheDocument()
  })

  it('opens from the fourth image at the fourth, with more beyond it', () => {
    renderMessage(
      ['1.png', '2.png', '3.png', '4.png', '5.png'].map(n => image(n))
    )
    fireEvent.click(screen.getByRole('button', { name: 'View 4.png' }))
    const viewer = screen.getByRole('dialog', { name: 'Image 4 of 5' })
    expect(within(viewer).getAllByRole('img')).toHaveLength(5)
  })

  it('shows a placeholder in the viewer for an image that fails to load', () => {
    renderMessage([image('1.png')])
    fireEvent.click(screen.getByRole('button', { name: 'View 1.png' }))
    const viewer = screen.getByRole('dialog')
    fireEvent.error(within(viewer).getByRole('img', { name: '1.png' }))
    expect(within(viewer).getByTestId('viewer-placeholder')).toBeInTheDocument()
  })
})

describe('UserMessage: files', () => {
  it('shows a file as a chip with its name and type that opens it', () => {
    renderMessage([PDF, { type: 'text', text: 'Summarise' }])
    const chip = screen.getByRole('button', { name: 'Open report.pdf' })
    expect(chip).toHaveTextContent('report.pdf')
    expect(chip).toHaveTextContent('PDF')
    fireEvent.click(chip)
    expect(Browser.open).toHaveBeenCalledWith({
      url: `${BASE}/uploads/report.pdf?sig=2`
    })
  })

  it('opens a file with a relative URL under the API base', () => {
    renderMessage([{ ...PDF, url: '/uploads/u/report.pdf' }])
    fireEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }))
    expect(Browser.open).toHaveBeenCalledWith({
      url: `${BASE}/uploads/u/report.pdf`
    })
  })

  it('names a file without a filename', () => {
    renderMessage([{ ...PDF, filename: undefined }])
    expect(screen.getByRole('button', { name: 'Open File' })).toBeVisible()
  })

  it('shows a file with an unsafe URL as a chip that does not open', () => {
    renderMessage([{ ...PDF, url: 'file:///etc/passwd' }])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('report.pdf')).toBeInTheDocument()
  })
})

describe('UserMessage: source URLs', () => {
  it('shows a pasted URL as a link chip that opens it', () => {
    renderMessage([
      { type: 'text', text: 'Read this' },
      { type: 'data-sourceUrl', data: { url: 'https://www.example.test/a' } }
    ])
    const chip = screen.getByRole('button', {
      name: 'Open https://www.example.test/a'
    })
    expect(chip).toHaveTextContent('example.test')
    // The site's icon, as the sources show it.
    expect(chip.querySelector('img')).toHaveAttribute(
      'src',
      'https://www.google.com/s2/favicons?domain=example.test&sz=64'
    )
    fireEvent.click(chip)
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://www.example.test/a'
    })
  })

  it('shows a link icon when the site icon fails to load', () => {
    renderMessage([
      { type: 'data-sourceUrl', data: { url: 'https://example.test/a' } }
    ])
    const chip = screen.getByRole('button', {
      name: 'Open https://example.test/a'
    })
    fireEvent.error(chip.querySelector('img')!)
    expect(chip.querySelector('img')).toBeNull()
    expect(within(chip).getByTestId('link-icon')).toBeInTheDocument()
  })

  it('shows an unsafe URL as plain text that does not open', () => {
    renderMessage([
      { type: 'data-sourceUrl', data: { url: 'javascript:alert(1)' } }
    ])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument()
  })

  it('does not resolve a relative path as a pasted link', () => {
    renderMessage([
      { type: 'data-sourceUrl', data: { url: '/uploads/u/a.pdf' } }
    ])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('/uploads/u/a.pdf')).toBeInTheDocument()
  })

  it('skips an empty source URL', () => {
    const { container } = renderMessage([{ type: 'data-sourceUrl', data: {} }])
    expect(container).toBeEmptyDOMElement()
  })
})

describe('UserMessage: pasted and quoted content', () => {
  const LONG = 'A long pasted passage.\nWith a second line.'

  it('collapses pasted content to a labelled block that expands and collapses', () => {
    renderMessage([
      { type: 'text', text: 'Explain' },
      { type: 'data-pastedContent', data: { text: LONG } }
    ])
    const toggle = screen.getByRole('button', { name: /Pasted content/ })
    expect(toggle).toHaveTextContent(`${LONG.length} chars`)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/A long pasted passage/)).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('blockquote')).toHaveTextContent(
      'A long pasted passage. With a second line.'
    )

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('blockquote')).not.toBeInTheDocument()
  })

  it('labels quoted context', () => {
    renderMessage([
      { type: 'data-quotedContext', data: { text: 'Earlier answer' } }
    ])
    const toggle = screen.getByRole('button', { name: /Quoted context/ })
    fireEvent.click(toggle)
    expect(screen.getByRole('blockquote')).toHaveTextContent('Earlier answer')
  })

  it('lets the question and a quote be selected and copied', () => {
    renderMessage([
      { type: 'text', text: 'Why is the sky blue?' },
      { type: 'data-quotedContext', data: { text: 'Earlier answer' } }
    ])
    expect(screen.getByTestId('user-bubble')).toHaveClass('selectable')
    fireEvent.click(screen.getByRole('button', { name: /Quoted context/ }))
    expect(screen.getByRole('blockquote')).toHaveClass('selectable')
  })

  it('splits legacy <user-content> blocks out of the text, as the web does', () => {
    renderMessage([
      {
        type: 'text',
        text: '<user-content>\nold paste\n</user-content>\n\nSummarise this'
      },
      { type: 'data-pastedContent', data: { text: 'new paste' } },
      { type: 'data-quotedContext', data: { text: 'quoted' } }
    ])
    expect(screen.getByTestId('user-bubble')).toHaveTextContent(
      /^Summarise this$/
    )
    expect(screen.queryByText(/user-content/)).not.toBeInTheDocument()

    // The legacy card first, then the new pasted part, then the quote.
    const toggles = screen.getAllByRole('button', { expanded: false })
    expect(toggles.map(t => t.textContent)).toEqual([
      'Pasted content · 9 chars',
      'Pasted content · 9 chars',
      'Quoted context · 6 chars'
    ])
    fireEvent.click(toggles[0])
    expect(screen.getByRole('blockquote')).toHaveTextContent(/^old paste$/)
  })

  it('shows no bubble when the text is only a legacy pasted block', () => {
    renderMessage([
      { type: 'text', text: '<user-content>only paste</user-content>' }
    ])
    expect(screen.queryByTestId('user-bubble')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Pasted content · 10 chars/ })
    ).toBeVisible()
  })
})

describe('UserMessage: tap targets', () => {
  it('the quote toggle and link chips keep their look, with a 44-pt hit area, unclipped', () => {
    const { container } = renderMessage([
      { type: 'text', text: 'Explain' },
      { type: 'data-pastedContent', data: { text: 'Pasted' } },
      { type: 'data-quotedContext', data: { text: 'Quoted' } },
      { type: 'data-sourceUrl', data: { url: 'https://example.test/a' } },
      { type: 'data-sourceUrl', data: { url: 'https://example.test/b' } }
    ])
    const toggles = [
      screen.getByRole('button', { name: /Pasted content/ }),
      screen.getByRole('button', { name: /Quoted context/ })
    ]
    const chips = [
      screen.getByRole('button', { name: 'Open https://example.test/a' }),
      screen.getByRole('button', { name: 'Open https://example.test/b' })
    ]
    for (const toggle of toggles) expect(toggle).toHaveClass('min-h-9')
    for (const chip of chips) expect(chip).toHaveClass('py-1.5')
    // Wrapped rows of 34 px chips sit 44 px centre to centre (a 10 px row
    // gap), so their hit areas meet halfway instead of the lower row's
    // reaching over the gap.
    expect(chips[0].parentElement).toHaveClass('gap-x-1.5', 'gap-y-2.5')
    for (const control of [...toggles, ...chips]) {
      expect(control).toHaveClass('hit-target')
      expect(clippingAncestors(control, container)).toEqual([])
    }
  })
})
