import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import type { UIMessage } from 'ai'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import {
  COPY_ERROR,
  COPIED_MS,
  MessageActions,
  SHARE_ERROR
} from '@/features/thread/components/MessageActions'
import { listSources } from '@/features/thread/model/citations'
import { extractCitationMaps } from '@/lib/utils/citation'

vi.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: vi.fn(async () => {}) }
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => ({})) }
}))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

const TEXT = '## Answer\n\nFact one [1](#call_a). Fact two [2](#call_a).'

const message = {
  id: 'm1',
  role: 'assistant',
  parts: [
    {
      type: 'tool-search',
      toolCallId: 'call_a',
      state: 'output-available',
      input: { query: 'q' },
      output: {
        state: 'complete',
        query: 'q',
        images: [],
        results: [
          { title: 'A', url: 'https://example.com/a', content: 'a' },
          { title: 'B', url: 'https://other.test.invalid/b', content: 'b' },
          { title: 'C', url: 'https://unused.test.invalid/c', content: 'c' }
        ]
      }
    },
    { type: 'text', text: TEXT }
  ]
} as UIMessage

const maps = extractCitationMaps(message)
const sources = listSources(message)

function actions(onRetry = vi.fn(), text = TEXT, list = sources) {
  render(
    <MessageActions
      text={text}
      maps={maps}
      question="What are the facts?"
      sources={list}
      onRetry={onRetry}
    />
  )
  return onRetry
}

beforeEach(() => {
  vi.mocked(haptic).mockClear()
  vi.mocked(Clipboard.write).mockReset().mockResolvedValue()
  vi.mocked(Share.share).mockReset().mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MessageActions', () => {
  it('copies the answer without citation anchors and shows Copied for a moment', async () => {
    vi.useFakeTimers()
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    const copied = vi.mocked(Clipboard.write).mock.calls[0][0].string!
    expect(copied).not.toContain('#call_a')
    expect(copied).toContain('Fact one')
    expect(copied).toContain('(https://example.com/a)')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(COPIED_MS)
    })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('shows an error when the copy fails', async () => {
    vi.mocked(Clipboard.write).mockRejectedValue(new Error('denied'))
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(COPY_ERROR)
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('shares the question, the answer and the cited URLs', async () => {
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    const { title, text } = vi.mocked(Share.share).mock.calls[0][0]
    expect(title).toBe('What are the facts?')
    expect(text).not.toContain('#call_a')
    expect(text).toMatch(
      /\n\nSources:\nhttps:\/\/example\.com\/a\nhttps:\/\/other\.test\.invalid\/b$/
    )
    expect(text).not.toContain('unused.test.invalid')
  })

  it('shares no Sources block when nothing is cited', async () => {
    const uncited = sources.map(s => ({ ...s, cited: false }))
    actions(vi.fn(), '## Answer\n\nNo citations here.', uncited)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    const { text } = vi.mocked(Share.share).mock.calls[0][0]
    expect(text).toBe('## Answer\n\nNo citations here.')
  })

  it('treats a cancelled share as no error', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('Share canceled'))
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats a cancel rejected as a bare string as no error', async () => {
    vi.mocked(Share.share).mockRejectedValue('User cancelled')
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an error when the share fails', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('unavailable'))
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent(SHARE_ERROR)
  })

  it('clears an earlier error on the next action', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('unavailable'))
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('retries', () => {
    const onRetry = actions()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('opens the sources sheet from the Sources button', () => {
    actions()
    fireEvent.click(screen.getByRole('button', { name: 'Sources (3)' }))
    const dialog = screen.getByRole('dialog', { name: 'Sources' })
    expect(within(dialog).getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no Sources button when there are no sources', () => {
    actions(vi.fn(), TEXT, [])
    expect(
      screen.queryByRole('button', { name: /Sources/ })
    ).not.toBeInTheDocument()
  })

  it('stops the Copied timer when it goes away', async () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <MessageActions
        text={TEXT}
        maps={maps}
        question="q"
        sources={sources}
        onRetry={() => {}}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('MessageActions haptics', () => {
  it('a copy that lands taps success, once', async () => {
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(haptic).toHaveBeenCalledExactlyOnceWith('success')
  })

  it('a copy that fails makes none', async () => {
    vi.mocked(Clipboard.write).mockRejectedValue(new Error('denied'))
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    expect(haptic).not.toHaveBeenCalled()
  })
})
