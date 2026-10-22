import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { haptic } from '@/core/haptics'
import { ConfirmSheet, type ConfirmSheetProps } from '@/core/ui/ConfirmSheet'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

function setup(props: Partial<ConfirmSheetProps> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  render(
    <ConfirmSheet
      open
      title="Delete this chat?"
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />
  )
  return { onConfirm, onClose }
}

describe('ConfirmSheet', () => {
  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the title, the message and both choices in a sheet', () => {
    setup({ message: 'This can’t be undone.' })
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Delete this chat?')
    expect(screen.getByText('This can’t be undone.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('shows no message paragraph without a message', () => {
    setup()
    expect(screen.getByRole('dialog').querySelector('p')).toBeNull()
  })

  it('confirms and then closes', () => {
    const { onConfirm, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      onClose.mock.invocationCallOrder[0]
    )
  })

  it('closes without confirming on Cancel', () => {
    const { onConfirm, onClose } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('closes without confirming on a backdrop tap', () => {
    const { onConfirm, onClose } = setup()
    fireEvent.click(screen.getByTestId('sheet-backdrop'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('paints a destructive confirm red', () => {
    setup({ tone: 'destructive' })
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain(
      'bg-red-500'
    )
  })

  it('paints a plain confirm in the foreground colour', () => {
    setup({ confirmLabel: 'OK' })
    const ok = screen.getByRole('button', { name: 'OK' })
    expect(ok.className).not.toContain('bg-red-500')
    expect(ok.className).toContain('bg-foreground')
  })
})

describe('ConfirmSheet haptics', () => {
  beforeEach(() => vi.mocked(haptic).mockClear())

  it('a destructive confirm warns, once', () => {
    const { onConfirm } = setup({ tone: 'destructive' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenCalledExactlyOnceWith('warning')
  })

  it('a plain confirm, or Cancel, makes none', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(haptic).not.toHaveBeenCalled()
  })

  it('cancelling a destructive confirm makes none', () => {
    setup({ tone: 'destructive' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(haptic).not.toHaveBeenCalled()
  })
})
