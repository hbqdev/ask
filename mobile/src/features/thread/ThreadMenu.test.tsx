import { Clipboard } from '@capacitor/clipboard'
import { Share } from '@capacitor/share'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { onChatsChanged } from '@/core/chats-events'
import { haptic } from '@/core/haptics'
import { deleteChat, renameChat } from '@/features/library/library-api'
import { COPIED_MS } from '@/features/thread/components/MessageActions'
import { ThreadMenu } from '@/features/thread/ThreadMenu'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/features/library/library-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/library/library-api')>()),
  renameChat: vi.fn(),
  deleteChat: vi.fn()
}))
vi.mock('@capacitor/clipboard', () => ({
  Clipboard: { write: vi.fn(async () => {}) }
}))
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn(async () => ({})) }
}))
vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

const LINK = 'https://ask.example.invalid/search/c1'

const client = { url: vi.fn() } as unknown as ApiClient
const onRenamed = vi.fn()
const onDeleted = vi.fn()
const createLink = vi.fn<() => Promise<string>>()
const stopSharing = vi.fn<() => Promise<void>>()
const changed = vi.fn()
let unsubscribe: () => void

function menuOf(title: string, shared: boolean) {
  return (
    <ThreadMenu
      chatId="c1"
      title={title}
      onRenamed={onRenamed}
      onDeleted={onDeleted}
      shared={shared}
      createLink={createLink}
      stopSharing={stopSharing}
    />
  )
}

function renderMenu(title = 'Old title', { shared = false } = {}) {
  const view = render(menuOf(title, shared))
  return {
    ...view,
    setShared: (next: boolean) => view.rerender(menuOf(title, next))
  }
}

const menuButton = () => screen.getByRole('button', { name: 'Chat options' })
const menu = () => screen.getByRole('dialog', { name: 'Chat options' })

async function openMenu() {
  await userEvent.click(menuButton())
  return menu()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useApi).mockReturnValue({ client } as Api)
  createLink.mockResolvedValue(LINK)
  stopSharing.mockResolvedValue()
  vi.mocked(Share.share).mockReset().mockResolvedValue({})
  vi.mocked(Clipboard.write).mockReset().mockResolvedValue()
  unsubscribe = onChatsChanged(changed)
})

afterEach(() => {
  unsubscribe()
  vi.useRealTimers()
})

describe('ThreadMenu', () => {
  it('opens a sheet with Share link, Rename and Delete chat', async () => {
    renderMenu()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const sheet = await openMenu()

    expect(
      within(sheet)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['Share link', 'Rename', 'Delete chat'])
  })

  it('offers Copy link and Stop sharing too once the chat is shared', async () => {
    renderMenu('Old title', { shared: true })

    const sheet = await openMenu()

    expect(
      within(sheet)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual([
      'Share link',
      'Copy link',
      'Stop sharing',
      'Rename',
      'Delete chat'
    ])
  })

  describe('share link', () => {
    const shareLinkButton = () =>
      within(menu()).getByRole('button', { name: /Share link|Creating link/ })

    it('creates the link, closes the menu and opens the share sheet with the title and link', async () => {
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())

      expect(createLink).toHaveBeenCalledOnce()
      expect(Share.share).toHaveBeenCalledExactlyOnceWith({
        title: 'Old title',
        url: LINK
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows that it is creating the link, and takes no other tap, until it is made', async () => {
      let made!: (url: string) => void
      createLink.mockReturnValue(new Promise(resolve => (made = resolve)))
      renderMenu('Old title', { shared: true })
      await openMenu()
      await userEvent.click(shareLinkButton())

      const busy = within(menu()).getByRole('button', {
        name: 'Creating link…'
      })
      expect(busy).toHaveAttribute('aria-busy', 'true')
      for (const button of within(menu()).getAllByRole('button')) {
        expect(button).toBeDisabled()
      }

      await act(async () => made(LINK))
      expect(Share.share).toHaveBeenCalledOnce()
    })

    it('treats a cancelled share sheet as no error', async () => {
      vi.mocked(Share.share).mockRejectedValue(new Error('Share canceled'))
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())

      expect(Share.share).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says so under the header when the share sheet fails', async () => {
      vi.mocked(Share.share).mockRejectedValue(new Error('unavailable'))
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t share the link.'
      )
    })

    it('says so in the menu when the link cannot be made, and opens no share sheet', async () => {
      createLink.mockRejectedValue(
        new ApiError(0, 'Network error. Check your connection.')
      )
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())

      expect(within(menu()).getByRole('alert')).toHaveTextContent(
        'Couldn’t create the link. Network error. Check your connection.'
      )
      expect(Share.share).not.toHaveBeenCalled()
      // The menu is usable again.
      expect(shareLinkButton()).toBeEnabled()
      expect(shareLinkButton()).toHaveTextContent('Share link')
    })

    it('opens no share sheet when the menu was closed while the link was made', async () => {
      let made!: (url: string) => void
      createLink.mockReturnValue(new Promise(resolve => (made = resolve)))
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      await act(async () => made(LINK))

      expect(Share.share).not.toHaveBeenCalled()
      // Opening the menu again starts afresh.
      await openMenu()
      expect(shareLinkButton()).toHaveTextContent('Share link')
    })

    it('says nothing when the menu was closed before the link failed', async () => {
      let fail!: (error: Error) => void
      createLink.mockReturnValue(new Promise((_, reject) => (fail = reject)))
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())
      await userEvent.keyboard('{Escape}')

      await act(async () => fail(new Error('Server error')))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('clears a link error when the menu opens again', async () => {
      createLink.mockRejectedValue(new Error('Server error'))
      renderMenu()
      await openMenu()
      await userEvent.click(shareLinkButton())
      expect(within(menu()).getByRole('alert')).toBeInTheDocument()

      await userEvent.keyboard('{Escape}')
      await openMenu()

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('copy link', () => {
    const copyButton = () =>
      within(menu()).getByRole('button', { name: /Copy link|Copied/ })

    it('copies the link, taps success and reads Copied for a moment, keeping the menu open', async () => {
      renderMenu('Old title', { shared: true })
      await openMenu()
      vi.useFakeTimers()

      await act(async () => copyButton().click())

      expect(createLink).toHaveBeenCalledOnce()
      expect(Clipboard.write).toHaveBeenCalledExactlyOnceWith({ string: LINK })
      expect(haptic).toHaveBeenCalledExactlyOnceWith('success')
      expect(copyButton()).toHaveTextContent('Copied')
      act(() => {
        vi.advanceTimersByTime(COPIED_MS)
      })
      expect(copyButton()).toHaveTextContent('Copy link')
    })

    it('says so in the menu when the copy fails, with no haptic', async () => {
      vi.mocked(Clipboard.write).mockRejectedValue(new Error('denied'))
      renderMenu('Old title', { shared: true })
      await openMenu()
      await userEvent.click(copyButton())

      expect(within(menu()).getByRole('alert')).toHaveTextContent(
        'Couldn’t copy the link.'
      )
      expect(haptic).not.toHaveBeenCalled()
      expect(copyButton()).toHaveTextContent('Copy link')
    })

    it('says so in the menu when the link cannot be made', async () => {
      createLink.mockRejectedValue(new Error('Server error'))
      renderMenu('Old title', { shared: true })
      await openMenu()
      await userEvent.click(copyButton())

      expect(within(menu()).getByRole('alert')).toHaveTextContent(
        'Couldn’t create the link. Server error'
      )
      expect(Clipboard.write).not.toHaveBeenCalled()
    })

    it('stops the Copied timer when it goes away', async () => {
      const { unmount } = renderMenu('Old title', { shared: true })
      await openMenu()
      vi.useFakeTimers()
      await act(async () => copyButton().click())

      unmount()

      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('stop sharing', () => {
    async function confirmStop() {
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Stop sharing' })
      )
      const confirm = screen.getByRole('dialog', {
        name: 'Stop sharing this chat?'
      })
      expect(confirm).toHaveTextContent(
        'The link will stop working for anyone who has it.'
      )
      await userEvent.click(
        within(confirm).getByRole('button', { name: 'Stop sharing' })
      )
    }

    it('stops sharing after confirming', async () => {
      renderMenu('Old title', { shared: true })

      await confirmStop()

      expect(stopSharing).toHaveBeenCalledOnce()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says so under the header when it fails', async () => {
      stopSharing.mockRejectedValue(new Error('Server error'))
      renderMenu('Old title', { shared: true })

      await confirmStop()

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t stop sharing. Server error'
      )
    })

    it('does nothing on Cancel', async () => {
      renderMenu('Old title', { shared: true })
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Stop sharing' })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(stopSharing).not.toHaveBeenCalled()
    })

    it('is no longer offered once the chat is private', async () => {
      const { setShared } = renderMenu('Old title', { shared: true })
      setShared(false)

      const sheet = await openMenu()

      expect(
        within(sheet).queryByRole('button', { name: 'Stop sharing' })
      ).not.toBeInTheDocument()
      expect(
        within(sheet).queryByRole('button', { name: 'Copy link' })
      ).not.toBeInTheDocument()
    })
  })

  describe('rename', () => {
    it('renames with the trimmed title and passes on the saved one', async () => {
      vi.mocked(renameChat).mockResolvedValue('Saved title')
      renderMenu()
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Rename' })
      )

      // The menu gives way to the prompt, filled with the current title.
      expect(
        screen.queryByRole('dialog', { name: 'Chat options' })
      ).not.toBeInTheDocument()
      const field = screen.getByRole('textbox', { name: 'Rename chat' })
      expect(field).toHaveValue('Old title')
      expect(field).toHaveAttribute('maxLength', '255')
      await userEvent.clear(field)
      await userEvent.type(field, '  New title  {Enter}')

      expect(renameChat).toHaveBeenCalledExactlyOnceWith(
        client,
        'c1',
        'New title'
      )
      expect(onRenamed).toHaveBeenCalledExactlyOnceWith('Saved title')
      expect(changed).toHaveBeenCalledExactlyOnceWith('renamed', 'c1', {
        title: 'Saved title'
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says so when the rename fails, and keeps the title', async () => {
      vi.mocked(renameChat).mockRejectedValue(
        new ApiError(0, 'Network error. Check your connection.')
      )
      renderMenu()
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Rename' })
      )
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Rename chat' }),
        '!{Enter}'
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t rename the chat. Network error. Check your connection.'
      )
      expect(onRenamed).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    })

    it('closes the prompt on Cancel without renaming', async () => {
      renderMenu()
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Rename' })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(renameChat).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    async function confirmDelete() {
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Delete chat' })
      )
      const confirm = screen.getByRole('dialog', { name: 'Delete this chat?' })
      expect(confirm).toHaveTextContent('This can’t be undone.')
      await userEvent.click(
        within(confirm).getByRole('button', { name: 'Delete' })
      )
    }

    it('deletes after confirming, then says so and leaves', async () => {
      vi.mocked(deleteChat).mockResolvedValue()
      renderMenu()

      await confirmDelete()

      expect(deleteChat).toHaveBeenCalledExactlyOnceWith(client, 'c1')
      expect(changed).toHaveBeenCalledExactlyOnceWith('deleted', 'c1')
      expect(onDeleted).toHaveBeenCalledOnce()
      // Told before leaving, so the Library has already dropped the row.
      expect(changed.mock.invocationCallOrder[0]).toBeLessThan(
        onDeleted.mock.invocationCallOrder[0]
      )
    })

    it('shows that it is deleting, and cannot be opened again, until the delete ends', async () => {
      let fail!: (error: Error) => void
      vi.mocked(deleteChat).mockReturnValue(
        new Promise<void>((_, reject) => (fail = reject))
      )
      renderMenu()

      await confirmDelete()

      expect(screen.getByRole('status')).toHaveTextContent('Deleting chat…')
      expect(menuButton()).toBeDisabled()
      expect(menuButton()).toHaveAttribute('aria-busy', 'true')

      await act(async () => fail(new Error('Server error')))
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(menuButton()).toBeEnabled()
      expect(menuButton()).not.toHaveAttribute('aria-busy')
    })

    it('treats a chat already gone on the server as deleted', async () => {
      vi.mocked(deleteChat).mockRejectedValue(new ApiError(404, 'Not found'))
      renderMenu()

      await confirmDelete()

      expect(changed).toHaveBeenCalledExactlyOnceWith('deleted', 'c1')
      expect(onDeleted).toHaveBeenCalledOnce()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says so when the delete fails, and stays', async () => {
      vi.mocked(deleteChat).mockRejectedValue(new Error('Server error'))
      renderMenu()

      await confirmDelete()

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t delete the chat. Server error'
      )
      expect(onDeleted).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    })

    it('delete resolving after leaving does not pop', async () => {
      let finish!: () => void
      vi.mocked(deleteChat).mockReturnValue(
        new Promise<void>(resolve => (finish = resolve))
      )
      const { unmount } = renderMenu()
      await confirmDelete()
      // The user goes back while the delete is on its way.
      unmount()

      await act(async () => finish())

      // The list is still told; the screen now on top is left alone.
      expect(changed).toHaveBeenCalledExactlyOnceWith('deleted', 'c1')
      expect(onDeleted).not.toHaveBeenCalled()
    })

    it('a failed delete after leaving says nothing', async () => {
      let fail!: (error: Error) => void
      vi.mocked(deleteChat).mockReturnValue(
        new Promise<void>((_, reject) => (fail = reject))
      )
      const { unmount } = renderMenu()
      await confirmDelete()
      unmount()

      await act(async () => fail(new Error('Server error')))

      expect(changed).not.toHaveBeenCalled()
      expect(onDeleted).not.toHaveBeenCalled()
    })

    it('does nothing on Cancel', async () => {
      renderMenu()
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Delete chat' })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(deleteChat).not.toHaveBeenCalled()
      expect(onDeleted).not.toHaveBeenCalled()
    })
  })

  describe('failure text', () => {
    async function fail() {
      vi.mocked(deleteChat).mockRejectedValue('boom')
      renderMenu()
      await userEvent.click(
        within(await openMenu()).getByRole('button', { name: 'Delete chat' })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
      return screen.findByRole('alert')
    }

    it('shows a non-Error reason as text', async () => {
      expect(await fail()).toHaveTextContent('Couldn’t delete the chat. boom')
    })

    it('is dismissed with its button', async () => {
      const alert = await fail()
      await userEvent.click(
        within(alert).getByRole('button', { name: 'Dismiss' })
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('clears when the menu opens again', async () => {
      await fail()
      await act(async () => menuButton().click())
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })
})
