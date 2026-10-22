import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import type { UIMessage } from 'ai'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import {
  COPY_ERROR,
  MessageActions,
  SHARE_ERROR
} from '@/features/thread/components/MessageActions'
import { listSources } from '@/features/thread/model/citations'
import { COPIED_MS } from '@/features/thread/share-api'
import type { ReadAloud } from '@/features/voice/useReadAloud'
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

/** A read-aloud in a given state, recording its taps. */
function reader(state: ReadAloud['state'] = 'idle', error?: string): ReadAloud {
  return { state, error, toggle: vi.fn(), read: vi.fn() }
}

function actions(
  onRetry = vi.fn(),
  text = TEXT,
  list = sources,
  readAloud = reader()
) {
  render(
    <MessageActions
      text={text}
      maps={maps}
      question="What are the facts?"
      sources={list}
      onRetry={onRetry}
      readAloud={readAloud}
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

  it('shares the answer at once, offering no link, for a chat not saved yet', async () => {
    actions()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(Share.share).toHaveBeenCalledOnce()
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
        readAloud={reader()}
      />
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('MessageActions share choice', () => {
  const LINK = 'https://ask.example.invalid/search/c1'
  const linkToChat = vi.fn<() => Promise<{ title: string; url: string }>>()

  function withLink() {
    render(
      <MessageActions
        text={TEXT}
        maps={maps}
        question="What are the facts?"
        sources={sources}
        onRetry={() => {}}
        readAloud={reader()}
        linkToChat={linkToChat}
      />
    )
  }

  const choice = () => screen.getByRole('dialog', { name: 'Share' })
  const linkOption = () =>
    within(choice()).getByRole('button', {
      name: /Share link to chat|Creating link/
    })

  async function choose(name: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    await act(async () => {
      fireEvent.click(
        name === 'link'
          ? linkOption()
          : within(choice()).getByRole('button', { name })
      )
    })
  }

  beforeEach(() => {
    linkToChat.mockReset().mockResolvedValue({ title: 'Facts', url: LINK })
  })

  it('offers the answer or a link to the chat, sharing nothing yet', async () => {
    withLink()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(
      within(choice())
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['Share answer', 'Share link to chat'])
    expect(Share.share).not.toHaveBeenCalled()
    expect(linkToChat).not.toHaveBeenCalled()
  })

  it('shares the answer as before, after closing the choice', async () => {
    withLink()
    await choose('Share answer')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const { title, text } = vi.mocked(Share.share).mock.calls[0][0]
    expect(title).toBe('What are the facts?')
    expect(text).toMatch(/\n\nSources:\nhttps:\/\/example\.com\/a/)
    expect(linkToChat).not.toHaveBeenCalled()
  })

  it('says so under the actions when sharing the answer fails', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('unavailable'))
    withLink()
    await choose('Share answer')
    expect(screen.getByRole('alert')).toHaveTextContent(SHARE_ERROR)
  })

  it('makes the link, closes the choice and shares the chat’s title and link', async () => {
    withLink()
    await choose('link')
    expect(linkToChat).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(Share.share).toHaveBeenCalledExactlyOnceWith({
      title: 'Facts',
      url: LINK
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows that it is making the link, and takes no other tap, until it is made', async () => {
    let made!: (link: { title: string; url: string }) => void
    linkToChat.mockReturnValue(new Promise(resolve => (made = resolve)))
    withLink()
    await choose('link')

    const busy = within(choice()).getByRole('button', {
      name: 'Creating link…'
    })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    for (const button of within(choice()).getAllByRole('button')) {
      expect(button).toBeDisabled()
    }

    await act(async () => made({ title: 'Facts', url: LINK }))
    expect(Share.share).toHaveBeenCalledOnce()
  })

  it('treats a cancelled link share as no error', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('Share canceled'))
    withLink()
    await choose('link')
    expect(Share.share).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says so under the actions when the link’s share sheet fails', async () => {
    vi.mocked(Share.share).mockRejectedValue(new Error('unavailable'))
    withLink()
    await choose('link')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Couldn’t share the link.'
    )
  })

  it('says so in the choice when the link cannot be made, and stays open', async () => {
    linkToChat.mockRejectedValue(new Error('Not found'))
    withLink()
    await choose('link')
    expect(within(choice()).getByRole('alert')).toHaveTextContent(
      'Couldn’t create the link. Not found'
    )
    expect(Share.share).not.toHaveBeenCalled()
    expect(linkOption()).toBeEnabled()
    expect(linkOption()).toHaveTextContent('Share link to chat')
  })

  it('shows a non-Error reason as text', async () => {
    linkToChat.mockRejectedValue('boom')
    withLink()
    await choose('link')
    expect(within(choice()).getByRole('alert')).toHaveTextContent(
      'Couldn’t create the link. boom'
    )
  })

  it('opens no share sheet when the choice was closed while the link was made', async () => {
    let made!: (link: { title: string; url: string }) => void
    linkToChat.mockReturnValue(new Promise(resolve => (made = resolve)))
    withLink()
    await choose('link')
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => made({ title: 'Facts', url: LINK }))

    expect(Share.share).not.toHaveBeenCalled()
    // Opened again, the choice starts afresh.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(linkOption()).toHaveTextContent('Share link to chat')
    expect(linkOption()).toBeEnabled()
  })

  it('says nothing when the choice was closed before the link failed', async () => {
    let fail!: (error: Error) => void
    linkToChat.mockReturnValue(new Promise((_, reject) => (fail = reject)))
    withLink()
    await choose('link')
    fireEvent.click(screen.getByTestId('sheet-backdrop'))

    await act(async () => fail(new Error('Server error')))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears a link error when the choice opens again', async () => {
    linkToChat.mockRejectedValue(new Error('Not found'))
    withLink()
    await choose('link')
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('MessageActions read-aloud', () => {
  it('reads the answer aloud from the speaker button', () => {
    const readAloud = reader()
    actions(vi.fn(), TEXT, sources, readAloud)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    expect(readAloud.toggle).toHaveBeenCalledExactlyOnceWith(TEXT)
  })

  it('shows a spinner while the audio loads, and a tap cancels', () => {
    const readAloud = reader('loading')
    actions(vi.fn(), TEXT, sources, readAloud)
    const button = screen.getByRole('button', { name: 'Loading audio' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('.animate-spin')).not.toBeNull()
    fireEvent.click(button)
    expect(readAloud.toggle).toHaveBeenCalledTimes(1)
  })

  it('is a stop button while reading', () => {
    const readAloud = reader('playing')
    actions(vi.fn(), TEXT, sources, readAloud)
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }))
    expect(readAloud.toggle).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('button', { name: 'Read aloud' })
    ).not.toBeInTheDocument()
  })

  it('has no speaker for a turn without answer text', () => {
    actions(vi.fn(), '  ', sources, reader())
    expect(
      screen.queryByRole('button', { name: 'Read aloud' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('shows why the answer could not be read', () => {
    actions(
      vi.fn(),
      TEXT,
      sources,
      reader('error', 'Voice is unavailable right now')
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Voice is unavailable right now'
    )
    expect(
      screen.getByRole('button', { name: 'Read aloud' })
    ).toBeInTheDocument()
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
