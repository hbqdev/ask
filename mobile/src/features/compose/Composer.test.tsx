import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Composer,
  COMPOSER_MAX_HEIGHT_PX,
  type ComposerProps
} from '@/features/compose/Composer'
import type { OptionsSheetProps } from '@/features/compose/OptionsSheet'
import type { SearchSettings } from '@/features/thread/chat-body'

// The real sheet loads the model list from the server; here it is a stand-in
// that shows whether it is open and can change the settings.
vi.mock('@/features/compose/OptionsSheet', async importOriginal => ({
  ...(await importOriginal<typeof import('@/features/compose/OptionsSheet')>()),
  OptionsSheet: ({ open, onClose, settings, onSettings }: OptionsSheetProps) =>
    open ? (
      <div role="dialog" aria-label="Options">
        <button
          type="button"
          onClick={() => onSettings({ ...settings, searchMode: 'quality' })}
        >
          Pick quality
        </button>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    ) : null
}))

const BALANCED: SearchSettings = { searchMode: 'balanced', sources: ['web'] }

function setup(props: Partial<ComposerProps> = {}) {
  const onSend = vi.fn()
  const onStop = vi.fn()
  const onSettings = vi.fn()
  const utils = render(
    <Composer
      placeholder="Ask anything"
      busy={false}
      onSend={onSend}
      onStop={onStop}
      settings={BALANCED}
      onSettings={onSettings}
      {...props}
    />
  )
  const input = screen.getByRole('textbox', {
    name: 'Ask anything'
  }) as HTMLTextAreaElement
  return { ...utils, input, onSend, onStop, onSettings }
}

const sendButton = () => screen.getByRole('button', { name: 'Send' })

afterEach(() => {
  // Undo any scrollHeight a test defined on the prototype.
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number })
    .scrollHeight
})

describe('Composer', () => {
  it('disables Send while the text is blank', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    expect(sendButton()).toBeDisabled()

    await user.type(input, '   ')
    expect(sendButton()).toBeDisabled()

    await user.type(input, 'why')
    expect(sendButton()).toBeEnabled()
  })

  it('sends the trimmed text with the Send button and clears the field', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.type(input, '  why is the sky blue  ')
    await user.click(sendButton())

    expect(onSend).toHaveBeenCalledExactlyOnceWith('why is the sky blue')
    expect(input).toHaveValue('')
  })

  it('sends on Enter', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.type(input, 'hello{Enter}')

    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello')
    expect(input).toHaveValue('')
  })

  it('adds a newline on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two')

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one\nline two')
  })

  it('does not send on Enter during an IME composition', () => {
    const { input, onSend } = setup()
    fireEvent.change(input, { target: { value: 'にほん' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    // Safari reports the composition's Enter with keyCode 229.
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('にほん')
  })

  it('does not send a blank question on Enter', () => {
    const { input, onSend } = setup()
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows Stop while busy, which calls onStop and does not send', async () => {
    const user = userEvent.setup()
    const { input, onSend, onStop } = setup({ busy: true })
    expect(
      screen.queryByRole('button', { name: 'Send' })
    ).not.toBeInTheDocument()

    await user.type(input, 'next{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('next')

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('cannot send while disabled, though the text can still be typed', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup({ disabled: true })
    await user.type(input, 'early{Enter}')

    expect(input).toHaveValue('early')
    expect(sendButton()).toBeDisabled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the mode on a chip that opens the options sheet', async () => {
    const user = userEvent.setup()
    const { onSettings } = setup()
    const chip = screen.getByRole('button', { name: 'Search mode: Balanced' })
    expect(chip).toHaveTextContent('Balanced')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(chip)
    expect(screen.getByRole('dialog', { name: 'Options' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Pick quality' }))
    expect(onSettings).toHaveBeenCalledWith({
      searchMode: 'quality',
      sources: ['web']
    })

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names the chip after the current mode', () => {
    setup({ settings: { searchMode: 'quality', sources: ['web'] } })
    expect(
      screen.getByRole('button', { name: 'Search mode: Quality' })
    ).toBeInTheDocument()
  })

  it('grows with its text', () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 72
    })
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'one\ntwo\nthree' } })

    expect(input.style.height).toBe('72px')
    expect(input.style.overflowY).toBe('hidden')
  })

  it('stops growing at six lines and scrolls beyond them', () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1000
    })
    const { input } = setup()
    fireEvent.change(input, { target: { value: 'many\nlines' } })

    expect(COMPOSER_MAX_HEIGHT_PX).toBe(6 * 24 + 16)
    expect(input.style.height).toBe(`${COMPOSER_MAX_HEIGHT_PX}px`)
    expect(input.style.overflowY).toBe('auto')
  })

  it('takes focus when asked to', () => {
    const { input } = setup({ autoFocus: true })
    expect(input).toHaveFocus()
  })

  it('clears the home indicator with a safe-area bottom padding', () => {
    const { container } = setup()
    expect(container.firstElementChild).toHaveClass('composer')
    const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')
    expect(css).toMatch(
      /\.composer\s*\{[^}]*padding-bottom:\s*max\(env\(safe-area-inset-bottom\),\s*8px\)/
    )
  })
})
