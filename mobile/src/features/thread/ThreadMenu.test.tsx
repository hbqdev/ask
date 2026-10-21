import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { onChatsChanged } from '@/core/chats-events'
import { deleteChat, renameChat } from '@/features/library/library-api'
import { ThreadMenu } from '@/features/thread/ThreadMenu'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/features/library/library-api', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/library/library-api')>()),
  renameChat: vi.fn(),
  deleteChat: vi.fn()
}))

const client = { url: vi.fn() } as unknown as ApiClient
const onRenamed = vi.fn()
const onDeleted = vi.fn()
const changed = vi.fn()
let unsubscribe: () => void

function renderMenu(title = 'Old title') {
  return render(
    <ThreadMenu
      chatId="c1"
      title={title}
      onRenamed={onRenamed}
      onDeleted={onDeleted}
    />
  )
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
  unsubscribe = onChatsChanged(changed)
})

afterEach(() => unsubscribe())

describe('ThreadMenu', () => {
  it('opens a sheet with Rename and Delete chat', async () => {
    renderMenu()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const sheet = await openMenu()

    expect(
      within(sheet).getByRole('button', { name: 'Rename' })
    ).toBeInTheDocument()
    expect(
      within(sheet).getByRole('button', { name: 'Delete chat' })
    ).toBeInTheDocument()
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
