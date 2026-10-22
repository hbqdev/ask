import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { AttachmentChips } from '@/features/compose/AttachmentChips'
import type { Attachment } from '@/features/compose/useAttachments'

const item = (patch: Partial<Attachment>): Attachment => ({
  id: 'a1',
  name: 'photo.jpg',
  mediaType: 'image/jpeg',
  progress: 0,
  status: 'done',
  ...patch
})

function setup(items: Attachment[]) {
  const onRemove = vi.fn()
  const onRetry = vi.fn()
  const utils = render(
    <AttachmentChips items={items} onRemove={onRemove} onRetry={onRetry} />
  )
  return { ...utils, onRemove, onRetry }
}

const chip = (name: string) =>
  screen
    .getAllByRole('listitem')
    .find(li => within(li).queryByText(name) !== null)!

describe('AttachmentChips', () => {
  it('renders nothing without attachments', () => {
    const { container } = setup([])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an image as a thumbnail and any other file as an icon, each with its name', () => {
    setup([
      item({ id: 'a1', previewUrl: 'blob:preview-1' }),
      item({ id: 'a2', name: 'report.pdf', mediaType: 'application/pdf' })
    ])
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeVisible()

    const photo = chip('photo.jpg')
    // A decorative thumbnail (alt=""): the name beside it says what it is.
    expect(photo.querySelector('img')).toHaveAttribute('src', 'blob:preview-1')
    const doc = chip('report.pdf')
    expect(doc.querySelector('img')).toBeNull()
    expect(within(doc).getByTestId('file-icon')).toBeInTheDocument()
  })

  it('shows upload progress on a ring, and a spinning one while converting', () => {
    setup([
      item({ id: 'a1', status: 'uploading', progress: 0.4 }),
      item({ id: 'a2', name: 'IMG_2.HEIC', status: 'converting' })
    ])
    const uploading = within(chip('photo.jpg')).getByRole('progressbar')
    expect(uploading).toHaveAttribute('aria-valuenow', '40')
    expect(uploading).toHaveAccessibleName('Uploading photo.jpg')

    const converting = within(chip('IMG_2.HEIC')).getByRole('progressbar')
    expect(converting).not.toHaveAttribute('aria-valuenow')
    expect(converting).toHaveAccessibleName('Preparing IMG_2.HEIC')
  })

  it('shows no ring once uploaded', () => {
    setup([item({ status: 'done', progress: 1 })])
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('shows a failure retrying can fix with Retry', async () => {
    const user = userEvent.setup()
    const { onRetry } = setup([
      item({ status: 'error', error: 'Network error.', retryable: true })
    ])
    expect(screen.getByText('Network error.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry photo.jpg' }))
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('a1')
  })

  it('shows a failure retrying cannot fix with Remove only', () => {
    setup([
      item({ status: 'error', error: 'File too large', retryable: false })
    ])
    expect(screen.getByText('File too large')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Retry/ })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove photo.jpg' })
    ).toBeInTheDocument()
  })

  it('announces a failure, naming the file', () => {
    const { rerender, onRemove, onRetry } = setup([
      item({ status: 'uploading' })
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    rerender(
      <AttachmentChips
        items={[item({ status: 'error', error: 'Network error.' })]}
        onRemove={onRemove}
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'photo.jpg: Network error.'
    )
  })

  it('does not announce an indexing note as an alert', () => {
    setup([item({ status: 'done', ingestStatus: 'processing' })])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('gives Retry and Remove a 44-point hit area', () => {
    setup([item({ status: 'error', error: 'Network error.', retryable: true })])
    for (const name of ['Retry photo.jpg', 'Remove photo.jpg']) {
      expect(screen.getByRole('button', { name })).toHaveClass(
        'min-h-11',
        'min-w-11'
      )
    }
  })

  it('offers Retry only on a failed attachment', () => {
    setup([item({ status: 'uploading' })])
    expect(
      screen.queryByRole('button', { name: /^Retry/ })
    ).not.toBeInTheDocument()
  })

  it('removes an attachment with its × button', async () => {
    const user = userEvent.setup()
    const { onRemove } = setup([item({ status: 'uploading' })])
    await user.click(screen.getByRole('button', { name: 'Remove photo.jpg' }))
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('a1')
  })

  it("shows the server's note on an uploaded file's indexing", () => {
    setup([
      item({ id: 'a1', ingestStatus: 'processing' }),
      item({
        id: 'a2',
        name: 'huge.csv',
        ingestStatus: 'ready',
        ingestError: 'Indexed the first part only (file too large)'
      }),
      item({ id: 'a3', name: 'bad.pdf', ingestStatus: 'failed' })
    ])
    expect(within(chip('photo.jpg')).getByText('Processing…')).toBeVisible()
    expect(
      within(chip('huge.csv')).getByText(
        'Indexed the first part only (file too large)'
      )
    ).toBeVisible()
    expect(
      within(chip('bad.pdf')).getByText("Couldn't read this file")
    ).toBeVisible()
  })
})
