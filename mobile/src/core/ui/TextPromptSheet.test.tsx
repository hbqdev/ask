import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  TextPromptSheet,
  type TextPromptSheetProps
} from '@/core/ui/TextPromptSheet'

function setup(props: Partial<TextPromptSheetProps> = {}) {
  const onSubmit = vi.fn()
  const onClose = vi.fn()
  const all: TextPromptSheetProps = {
    open: true,
    title: 'Rename chat',
    initialValue: 'Old title',
    maxLength: 20,
    confirmLabel: 'Save',
    onSubmit,
    onClose,
    ...props
  }
  const view = render(<TextPromptSheet {...all} />)
  return { onSubmit, onClose, all, ...view }
}

const input = () => screen.getByRole('textbox')
const save = () => screen.getByRole('button', { name: 'Save' })

describe('TextPromptSheet', () => {
  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens with the initial value in a focused field named by the title', () => {
    setup()
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rename chat')
    expect(input()).toHaveValue('Old title')
    expect(input()).toHaveAccessibleName('Rename chat')
    expect(input()).toHaveFocus()
  })

  it('submits the trimmed value and then closes', async () => {
    const user = userEvent.setup()
    const { onSubmit, onClose } = setup()
    await user.clear(input())
    await user.type(input(), '  New title  ')
    await user.click(save())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('New title')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]
    )
  })

  it('submits on Enter', async () => {
    const user = userEvent.setup()
    const { onSubmit } = setup()
    await user.type(input(), ' 2{Enter}')
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Old title 2')
  })

  it('disables Save while the value is blank, and Enter does nothing', async () => {
    const user = userEvent.setup()
    const { onSubmit, onClose } = setup()
    await user.clear(input())
    expect(save()).toBeDisabled()
    await user.type(input(), '   ')
    expect(save()).toBeDisabled()
    await user.type(input(), '{Enter}')
    fireEvent.submit(input().closest('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('enforces maxLength, on typing and on a pasted change', async () => {
    const user = userEvent.setup()
    setup({ initialValue: '', maxLength: 5 })
    expect(input()).toHaveAttribute('maxLength', '5')
    await user.type(input(), 'abcdefgh')
    expect(input()).toHaveValue('abcde')
    fireEvent.change(input(), { target: { value: '1234567' } })
    expect(input()).toHaveValue('12345')
  })

  it('cuts a too-long initial value to maxLength', () => {
    setup({ initialValue: 'abcdefgh', maxLength: 3 })
    expect(input()).toHaveValue('abc')
  })

  it('closes without submitting on Cancel', async () => {
    const user = userEvent.setup()
    const { onSubmit, onClose } = setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('starts again from the initial value each time it opens', async () => {
    const user = userEvent.setup()
    const { all, rerender } = setup()
    await user.type(input(), ' edited')
    rerender(<TextPromptSheet {...all} open={false} />)
    rerender(<TextPromptSheet {...all} open />)
    expect(input()).toHaveValue('Old title')
  })
})
