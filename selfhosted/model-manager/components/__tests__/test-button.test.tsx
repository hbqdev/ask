import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestButton } from '../test-button'
import { specByKey } from '@/lib/env-schema'

describe('TestButton', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: true, models: ['granite4.1:8b'] }),
            { status: 200 }
          )
        )
    )
  })
  it('tests an ollama host and lists models', async () => {
    render(
      <TestButton spec={specByKey('OLLAMA_BASE_URL')!} value="http://h:11434" />
    )
    fireEvent.click(screen.getByRole('button', { name: /test/i }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/test', expect.anything())
    )
    expect(await screen.findByText('granite4.1:8b')).toBeInTheDocument()
  })
})
