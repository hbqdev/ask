import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useStack, type ScreenEntry, type Stack } from '@/core/nav/stack'
import { privacySections } from '@/features/settings/privacy-copy'
import { openPrivacy, PrivacyScreen } from '@/features/settings/PrivacyScreen'
import { expectReadableInScroller, readableColumn } from '@/test/readable'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/nav/stack', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/nav/stack')>()),
  useStack: vi.fn()
}))

const BASE = 'https://ask.test.invalid'
const pop = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useApi).mockReturnValue({
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl: vi.fn()
    }),
    baseUrl: BASE,
    getToken: async () => 'token',
    handleUnauthorized: async () => 'stop'
  } satisfies Api)
  vi.mocked(useStack).mockReturnValue({ pop } as unknown as Stack)
})

const firstParagraph = () =>
  screen.getByText(privacySections('ask.test.invalid')[0].paragraphs[0])

describe('openPrivacy', () => {
  it('pushes the Privacy screen', () => {
    const push = vi.fn()
    openPrivacy(push)
    expect(push).toHaveBeenCalledOnce()
    const entry = push.mock.calls[0][0] as ScreenEntry
    expect(entry.key).toBe('settings:privacy')
    render(<>{entry.render()}</>)
    const heading = screen.getByRole('heading', { level: 1, name: 'Privacy' })
    // The side columns hold a 44px button, as on the Memory screen.
    expect(heading.closest('header')).toHaveClass(
      'grid-cols-[48px_minmax(0,1fr)_48px]'
    )
  })
})

describe('PrivacyScreen', () => {
  it('shows each section as a heading with its paragraphs', () => {
    render(<PrivacyScreen />)
    const sections = privacySections('ask.test.invalid')
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map(h => h.textContent)).toEqual(sections.map(s => s.title))
    for (const section of sections) {
      for (const paragraph of section.paragraphs) {
        expect(screen.getByText(paragraph).tagName).toBe('P')
      }
    }
  })

  it('names the server host the app uses', () => {
    render(<PrivacyScreen />)
    expect(firstParagraph().textContent).toContain('(ask.test.invalid)')
  })

  it('goes back', () => {
    render(<PrivacyScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(pop).toHaveBeenCalledOnce()
  })

  it('the Back button is 44 pt', () => {
    render(<PrivacyScreen />)
    expect(screen.getByRole('button', { name: 'Back' })).toHaveClass('size-11')
  })

  it('scrolls (status-bar tap to top), clears the home indicator, and the text is selectable', () => {
    render(<PrivacyScreen />)
    const text = firstParagraph()
    const scroller = text.closest('[data-scroll-root]')
    expect(scroller).not.toBeNull()
    const content = text.closest('.safe-bottom')
    expect(content).not.toBeNull()
    expect(scroller).toContainElement(content as HTMLElement)
    expect(text.closest('.selectable')).not.toBeNull()
  })

  it('on an iPad, sets the text in the readable column; the bar spans the screen', () => {
    render(<PrivacyScreen />)
    expectReadableInScroller(firstParagraph())
    expect(
      readableColumn(screen.getByRole('button', { name: 'Back' }))
    ).toBeNull()
  })
})
