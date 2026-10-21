import { Browser } from '@capacitor/browser'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CitationChip } from '@/features/thread/components/CitationChip'
import type { Source } from '@/features/thread/model/citations'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

const SOURCE: Source = {
  url: 'https://example.com/a',
  title: 'Page <b>A</b> &amp; more',
  host: 'example.com',
  snippet: 'A snippet about A.',
  favicon: 'https://www.google.com/s2/favicons?domain=example.com&sz=64',
  cited: true
}

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('CitationChip', () => {
  it('shows the host and favicon as a pill', () => {
    const { container } = render(<CitationChip source={SOURCE} />)
    const chip = screen.getByRole('button', { name: /example\.com/ })
    expect(chip).toHaveTextContent('example.com')
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      SOURCE.favicon
    )
  })

  it('shows the host initial when the favicon fails to load', () => {
    const { container } = render(<CitationChip source={SOURCE} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('button')).toHaveTextContent('E')
  })

  it('opens a preview with the title, host and snippet on tap', () => {
    render(<CitationChip source={SOURCE} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /example\.com/ }))
    const dialog = screen.getByRole('dialog', { name: 'Page A & more' })
    expect(within(dialog).getByText('A snippet about A.')).toBeInTheDocument()
    expect(within(dialog).getByText('example.com')).toBeInTheDocument()
    expect(Browser.open).not.toHaveBeenCalled()
  })

  it('opens the source in the in-app browser from the preview', () => {
    render(<CitationChip source={SOURCE} />)
    fireEvent.click(screen.getByRole('button', { name: /example\.com/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://example.com/a' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the preview from the backdrop', () => {
    render(<CitationChip source={SOURCE} />)
    fireEvent.click(screen.getByRole('button', { name: /example\.com/ }))
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('titles the preview with the host when the source has no title', () => {
    render(<CitationChip source={{ ...SOURCE, title: '', snippet: '' }} />)
    fireEvent.click(screen.getByRole('button', { name: /example\.com/ }))
    expect(
      screen.getByRole('dialog', { name: 'example.com' })
    ).toBeInTheDocument()
  })
})
