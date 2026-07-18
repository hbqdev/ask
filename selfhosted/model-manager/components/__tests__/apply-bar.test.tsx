import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplyBar } from '../apply-bar'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null
}))
import { toast } from 'sonner'

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'))
      c.close()
    }
  })
}

describe('ApplyBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ diff: '~ OLLAMA_BASE_URL', targets: ['ask'] }),
            { status: 200 }
          )
        )
    )
  })
  it('shows the change count', () => {
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    expect(screen.getByText(/1 change/i)).toBeInTheDocument()
  })
  it('fetches and shows the masked diff on Review', async () => {
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/preview',
        expect.objectContaining({ method: 'POST' })
      )
    )
    expect(await screen.findByText(/OLLAMA_BASE_URL/)).toBeInTheDocument()
  })
  it('is disabled with no changes', () => {
    render(<ApplyBar edits={{}} />)
    expect(screen.getByRole('button', { name: /review/i })).toBeDisabled()
  })

  it('shows an error toast when a streamed apply event reports failure', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ diff: '~ OLLAMA_BASE_URL', targets: ['ask'] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          ndjsonStream([
            JSON.stringify({ step: 'backup', status: 'ok' }),
            JSON.stringify({
              step: 'ask-restart',
              status: 'fail',
              detail: 'boom'
            }),
            JSON.stringify({ step: 'done', status: 'fail' })
          ]),
          { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
        )
      )
    vi.stubGlobal('fetch', f)
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    fireEvent.click(
      await screen.findByRole('button', { name: /save & apply/i })
    )
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows a success toast when all streamed apply events succeed', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ diff: '~ OLLAMA_BASE_URL', targets: ['ask'] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          ndjsonStream([
            JSON.stringify({ step: 'backup', status: 'ok' }),
            JSON.stringify({ step: 'ask-restart', status: 'ok' }),
            JSON.stringify({ step: 'done', status: 'ok' })
          ]),
          { status: 200 }
        )
      )
    vi.stubGlobal('fetch', f)
    render(<ApplyBar edits={{ OLLAMA_BASE_URL: 'http://b' }} />)
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    fireEvent.click(
      await screen.findByRole('button', { name: /save & apply/i })
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('ApplyBar backups panel', () => {
  it('lists backups and POSTs the selected path on restore', async () => {
    const backups = [
      {
        path: '/data/.env.bak.2026-07-17T05-00-00-000Z',
        ts: '2026-07-17T05-00-00-000Z'
      },
      {
        path: '/data/.env.bak.2026-07-16T05-00-00-000Z',
        ts: '2026-07-16T05-00-00-000Z'
      }
    ]
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/backups') {
        return Promise.resolve(
          new Response(JSON.stringify({ backups }), { status: 200 })
        )
      }
      if (url === '/api/restore') {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, events: [] }), {
            status: 200
          })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ApplyBar edits={{}} />)
    fireEvent.click(screen.getByRole('button', { name: /backups/i }))

    await screen.findByText('2026-07-17T05-00-00-000Z')
    expect(screen.getByText('2026-07-16T05-00-00-000Z')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /restore/i })[0])

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            backupPath: '/data/.env.bak.2026-07-17T05-00-00-000Z'
          })
        })
      )
    )
  })
})
