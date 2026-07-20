import React from 'react'

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UploadedFile } from '@/lib/types'

import { UploadedFileList } from '../uploaded-file-list'

function makeFile(overrides: Partial<UploadedFile>): UploadedFile {
  return {
    status: 'uploaded',
    name: 'notes.txt',
    mediaType: 'text/plain',
    url: 'http://localhost/uploads/u1/chats/c1/notes.txt',
    objectKey: 'u1/chats/c1/notes.txt',
    ...overrides
  }
}

describe('UploadedFileList status chips', () => {
  it('shows a spinner with the ingest stage as its tooltip while processing', () => {
    render(
      <UploadedFileList
        files={[
          makeFile({ ingestStatus: 'processing', ingestStage: 'chunking' })
        ]}
        onRemove={vi.fn()}
      />
    )

    expect(screen.getByTitle('chunking')).toBeInTheDocument()
  })

  it('falls back to a "queued" tooltip when pending with no stage yet', () => {
    render(
      <UploadedFileList
        files={[makeFile({ ingestStatus: 'pending', ingestStage: null })]}
        onRemove={vi.fn()}
      />
    )

    expect(screen.getByTitle('queued')).toBeInTheDocument()
  })

  it('shows an error affordance with the failure reason when ingest failed', () => {
    render(
      <UploadedFileList
        files={[
          makeFile({
            ingestStatus: 'failed',
            ingestError: 'unsupported encoding'
          })
        ]}
        onRemove={vi.fn()}
      />
    )

    expect(screen.getByTitle('unsupported encoding')).toBeInTheDocument()
  })

  it('shows no ingest affordance once the file is ready', () => {
    render(
      <UploadedFileList
        files={[makeFile({ ingestStatus: 'ready' })]}
        onRemove={vi.fn()}
      />
    )

    expect(screen.queryByTitle('queued')).not.toBeInTheDocument()
    expect(screen.queryByTitle('chunking')).not.toBeInTheDocument()
    expect(screen.queryByTitle(/./)).not.toBeInTheDocument()
  })
})
