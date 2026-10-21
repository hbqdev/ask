import { Browser } from '@capacitor/browser'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SourcesSheet } from '@/features/thread/components/SourcesSheet'
import type { Source } from '@/features/thread/model/citations'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

function source(n: number, cited: boolean): Source {
  return {
    url: `https://site${n}.test.invalid/page`,
    title: `Title ${n}`,
    host: `site${n}.test.invalid`,
    snippet: `Snippet ${n}`,
    favicon: `https://www.google.com/s2/favicons?domain=site${n}.test.invalid&sz=64`,
    cited
  }
}

beforeEach(() => {
  vi.mocked(Browser.open).mockClear()
})

describe('SourcesSheet', () => {
  it('renders nothing while closed', () => {
    render(
      <SourcesSheet
        open={false}
        onClose={() => {}}
        sources={[source(1, true)]}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists the sources with the cited ones first, keeping their order', () => {
    const sources = [
      source(1, false),
      source(2, true),
      source(3, false),
      source(4, true)
    ]
    render(<SourcesSheet open onClose={() => {}} sources={sources} />)
    const dialog = screen.getByRole('dialog', { name: 'Sources' })
    const rows = within(dialog).getAllByRole('button')
    expect(rows.map(r => within(r).getByText(/^Title/).textContent)).toEqual([
      'Title 2',
      'Title 4',
      'Title 1',
      'Title 3'
    ])
    expect(rows[0]).toHaveTextContent('site2.test.invalid')
  })

  it('opens a row in the in-app browser', () => {
    render(<SourcesSheet open onClose={() => {}} sources={[source(1, true)]} />)
    fireEvent.click(screen.getByRole('button', { name: /Title 1/ }))
    expect(Browser.open).toHaveBeenCalledWith({
      url: 'https://site1.test.invalid/page'
    })
  })

  it('shows the host for a source with no title', () => {
    render(
      <SourcesSheet
        open
        onClose={() => {}}
        sources={[{ ...source(1, true), title: '' }]}
      />
    )
    expect(
      screen.getByRole('button', { name: /site1\.test\.invalid/ })
    ).toBeInTheDocument()
  })

  it('closes from the backdrop', () => {
    const onClose = vi.fn()
    render(<SourcesSheet open onClose={onClose} sources={[source(1, true)]} />)
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })
})
