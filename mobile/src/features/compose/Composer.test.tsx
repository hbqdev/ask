import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Tabs } from '@/app/Tabs'
import { useApi, type Api } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { haptic } from '@/core/haptics'
import { StackProvider, StackView, useStack } from '@/core/nav/stack'
import {
  Composer,
  COMPOSER_MAX_HEIGHT_PX,
  type ComposerProps
} from '@/features/compose/Composer'
import type { OptionsSheetProps } from '@/features/compose/OptionsSheet'
import { uploadFile, type UploadResult } from '@/features/compose/upload'
import type { SearchSettings } from '@/features/thread/chat-body'
import { startRecording, type Recording } from '@/features/voice/recorder'
import { transcribe } from '@/features/voice/transcribe'
import { ACCEPT_ATTRIBUTE } from '@/lib/config/upload-allowlist'

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

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/features/compose/upload', () => ({ uploadFile: vi.fn() }))
vi.mock('@/features/voice/recorder', () => ({ startRecording: vi.fn() }))
vi.mock('@/features/voice/transcribe', () => ({ transcribe: vi.fn() }))

type AppListener = (state: { isActive: boolean }) => void
type Registered = { event: string; listener: AppListener }
const app = vi.hoisted(() => ({
  listeners: [] as Array<{
    event: string
    listener: (state: { isActive: boolean }) => void
  }>
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: AppListener) => {
      const entry: Registered = { event, listener }
      app.listeners.push(entry)
      return {
        remove: async () => {
          const i = app.listeners.indexOf(entry)
          if (i >= 0) app.listeners.splice(i, 1)
        }
      }
    })
  }
}))

/** Fires an App event at the listeners for it. */
const emitApp = (event: string, state = { isActive: true }) =>
  act(async () =>
    app.listeners.filter(l => l.event === event).forEach(l => l.listener(state))
  )

const uploaded = (name: string): UploadResult => ({
  url: `https://ask.test.invalid/uploads/u1/chats/c1/1-${name}`,
  filename: name,
  mediaType: 'application/pdf',
  objectKey: `u1/chats/c1/1-${name}`,
  status: 'ready'
})

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue({
    baseUrl: 'https://ask.test.invalid',
    getToken: async () => 'tok',
    client: { json: vi.fn() }
  } as unknown as Api)
  vi.mocked(uploadFile).mockReset()
  vi.mocked(uploadFile).mockImplementation(async o => uploaded(o.filename))
})

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
const sendQuery = () => screen.queryByRole('button', { name: 'Send' })
const micButton = () => screen.getByRole('button', { name: 'Dictate' })
const micQuery = () => screen.queryByRole('button', { name: 'Dictate' })

afterEach(() => {
  // Undo any scrollHeight a test defined on the prototype.
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number })
    .scrollHeight
})

describe('Composer', () => {
  it('shows the mic instead of Send while the text is blank', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    expect(sendQuery()).not.toBeInTheDocument()
    expect(micButton()).toBeInTheDocument()

    await user.type(input, '   ')
    expect(sendQuery()).not.toBeInTheDocument()
    expect(micButton()).toBeInTheDocument()

    await user.type(input, 'why')
    expect(sendButton()).toBeEnabled()
    expect(micQuery()).not.toBeInTheDocument()

    await user.clear(input)
    expect(micButton()).toBeInTheDocument()
  })

  it('sends the trimmed text with the Send button and clears the field', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.type(input, '  why is the sky blue  ')
    await user.click(sendButton())

    expect(onSend).toHaveBeenCalledExactlyOnceWith('why is the sky blue', [])
    expect(input).toHaveValue('')
  })

  it('sends on Enter', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.type(input, 'hello{Enter}')

    expect(onSend).toHaveBeenCalledExactlyOnceWith('hello', [])
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
    expect(micQuery()).not.toBeInTheDocument()

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

  it('still renders for a mode it has no label for', () => {
    setup({
      settings: {
        searchMode: 'turbo',
        sources: ['web']
      } as unknown as SearchSettings
    })
    expect(
      screen.getByRole('button', { name: 'Search mode: turbo' })
    ).toBeInTheDocument()
  })

  it('puts a draft in the box, focused, without sending it', () => {
    const { input, onSend, rerender } = setup()
    const props = {
      placeholder: 'Ask anything',
      busy: false,
      onSend,
      settings: BALANCED,
      onSettings: vi.fn()
    }
    rerender(<Composer {...props} draft={{ text: 'From a link' }} />)

    expect(input).toHaveValue('From a link')
    expect(input).toHaveFocus()
    expect(sendButton()).toBeEnabled()
    expect(onSend).not.toHaveBeenCalled()

    // The same question again (a new draft) fills the box again.
    fireEvent.change(input, { target: { value: '' } })
    input.blur()
    rerender(<Composer {...props} draft={{ text: 'From a link' }} />)
    expect(input).toHaveValue('From a link')
    expect(input).toHaveFocus()
  })

  it('adds an appending draft on a new line under the text in the box', () => {
    const { input, onSend, rerender } = setup()
    const props = {
      placeholder: 'Ask anything',
      busy: false,
      onSend,
      settings: BALANCED,
      onSettings: vi.fn()
    }
    fireEvent.change(input, { target: { value: 'Summarise this:  ' } })
    input.blur()
    rerender(
      <Composer
        {...props}
        draft={{ text: 'https://a.example', append: true }}
      />
    )

    expect(input).toHaveValue('Summarise this:\nhttps://a.example')
    expect(input).toHaveFocus()
    expect(onSend).not.toHaveBeenCalled()

    // An empty (or blank) box just takes the draft.
    fireEvent.change(input, { target: { value: '  ' } })
    rerender(
      <Composer
        {...props}
        draft={{ text: 'https://b.example', append: true }}
      />
    )
    expect(input).toHaveValue('https://b.example')
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const pdf = (name = 'report.pdf') =>
  new File(['%PDF'], name, { type: 'application/pdf' })

const filePicker = () => screen.getByTestId('pick-files') as HTMLInputElement

describe('Composer attachments', () => {
  it('the paperclip opens a sheet whose options open the right pickers', async () => {
    const user = userEvent.setup()
    const clicked: HTMLInputElement[] = []
    const click = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(function (this: HTMLInputElement) {
        clicked.push(this)
      })
    try {
      setup()
      const open = async () => {
        await user.click(screen.getByRole('button', { name: 'Attach' }))
        return screen.getByRole('dialog', { name: 'Attach' })
      }

      await user.click(
        within(await open()).getByRole('button', { name: 'Photo Library' })
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await user.click(
        within(await open()).getByRole('button', { name: 'Take Photo' })
      )
      await user.click(
        within(await open()).getByRole('button', { name: 'Choose File' })
      )

      const [library, camera, files] = clicked
      expect(library).toHaveAttribute('type', 'file')
      expect(library).toHaveAttribute('accept', 'image/*')
      expect(library).not.toHaveAttribute('capture')
      expect(library.multiple).toBe(true)

      expect(camera).toHaveAttribute('accept', 'image/*')
      expect(camera).toHaveAttribute('capture', 'environment')

      expect(files).toHaveAttribute('accept', ACCEPT_ATTRIBUTE)
      expect(files).not.toHaveAttribute('capture')
      expect(files.multiple).toBe(true)
      expect(clicked).toHaveLength(3)
    } finally {
      click.mockRestore()
    }
  })

  it('closes the attach sheet without picking anything', async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole('button', { name: 'Attach' }))
    expect(screen.getByRole('dialog', { name: 'Attach' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows picked files as chips and resets the picker for the same file again', async () => {
    const user = userEvent.setup()
    setup({ chatId: 'c9' })
    await user.upload(filePicker(), pdf())

    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(filePicker().value).toBe('')
    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'report.pdf', chatId: 'c9' })
      )
    )
  })

  it('send is disabled while an attachment is uploading or failed', async () => {
    const user = userEvent.setup()
    const upload = deferred<UploadResult>()
    vi.mocked(uploadFile).mockReturnValueOnce(upload.promise)
    const { input, onSend } = setup()
    await user.type(input, 'What does it say?')
    await user.upload(filePicker(), pdf())

    await waitFor(() => expect(uploadFile).toHaveBeenCalled())
    expect(sendButton()).toBeDisabled()
    await user.type(input, '{Enter}')
    expect(onSend).not.toHaveBeenCalled()

    await act(async () =>
      upload.reject(new ApiError(503, 'Service unavailable'))
    )
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()

    // Retried and uploaded: it can go.
    await user.click(screen.getByRole('button', { name: 'Retry report.pdf' }))
    await waitFor(() => expect(sendButton()).toBeEnabled())
  })

  it('a failed attachment removed lets the question go', async () => {
    const user = userEvent.setup()
    vi.mocked(uploadFile).mockRejectedValueOnce(new ApiError(400, 'Nope'))
    const { input, onSend } = setup()
    await user.type(input, 'Hi')
    await user.upload(filePicker(), pdf())
    await screen.findByText('Nope')
    expect(sendButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Remove report.pdf' }))
    expect(sendButton()).toBeEnabled()
    await user.click(sendButton())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Hi', [])
  })

  it('says when picks go over the limit, until a file is removed or the question sent', async () => {
    const user = userEvent.setup()
    const notice = () => screen.queryByText('You can attach up to 10 files')
    setup()
    await user.upload(
      filePicker(),
      Array.from({ length: 11 }, (_, i) => pdf(`${i}.pdf`))
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    expect(notice()).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove 0.pdf' }))
    expect(notice()).not.toBeInTheDocument()

    await user.upload(filePicker(), [pdf('x.pdf'), pdf('y.pdf')])
    expect(notice()).toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())
    await user.click(sendButton())
    expect(notice()).not.toBeInTheDocument()
  })

  it('attachments alone can be sent, which clears them', async () => {
    const user = userEvent.setup()
    const { onSend } = setup()
    expect(sendQuery()).not.toBeInTheDocument()
    await user.upload(filePicker(), pdf())
    // An attachment, even uploading, swaps the mic for Send.
    expect(micQuery()).not.toBeInTheDocument()
    await waitFor(() => expect(sendButton()).toBeEnabled())

    await user.click(sendButton())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('', [
      {
        url: uploaded('report.pdf').url,
        filename: 'report.pdf',
        mediaType: 'application/pdf'
      }
    ])
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
    expect(micButton()).toBeInTheDocument()
  })

  it('sends the text with its files', async () => {
    const user = userEvent.setup()
    const { input, onSend } = setup()
    await user.upload(filePicker(), [pdf('a.pdf'), pdf('b.pdf')])
    await user.type(input, 'Compare these')
    await waitFor(() => expect(sendButton()).toBeEnabled())

    await user.type(input, '{Enter}')
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Compare these', [
      expect.objectContaining({ filename: 'a.pdf' }),
      expect.objectContaining({ filename: 'b.pdf' })
    ])
    expect(input).toHaveValue('')
  })
})

describe('Composer haptics', () => {
  beforeEach(() => vi.mocked(haptic).mockClear())

  it('a send with the button taps light, once', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    await user.type(input, 'why')
    expect(haptic).not.toHaveBeenCalled()
    await user.click(sendButton())
    expect(haptic).toHaveBeenCalledExactlyOnceWith('light')
  })

  it('a send on Enter taps light, once', async () => {
    const user = userEvent.setup()
    const { input } = setup()
    await user.type(input, 'hello{Enter}')
    expect(haptic).toHaveBeenCalledExactlyOnceWith('light')
  })

  it('no send, no haptic: a blank question, or a running turn', async () => {
    const user = userEvent.setup()
    const { input } = setup({ busy: true })
    await user.type(input, 'next{Enter}')
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(haptic).not.toHaveBeenCalled()
  })
})

describe('Composer dictation', () => {
  let recording: { [K in keyof Recording]: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    // Only the clock is faked, so a recording can last long enough.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.mocked(haptic).mockClear()
    recording = {
      stop: vi.fn(async () => new Blob(['voice'], { type: 'audio/mp4' })),
      cancel: vi.fn(),
      level: vi.fn(() => 0.2)
    }
    vi.mocked(startRecording).mockReset()
    vi.mocked(startRecording).mockResolvedValue(recording as Recording)
    vi.mocked(transcribe).mockReset()
    vi.mocked(transcribe).mockResolvedValue('why is the sky blue')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const speak = (ms = 2_000) => vi.setSystemTime(Date.now() + ms)

  async function record(user: ReturnType<typeof userEvent.setup>) {
    await user.click(micButton())
    return screen.findByRole('button', { name: 'Stop recording' })
  }

  it('the recording bar replaces the field, and cancel brings it back', async () => {
    const user = userEvent.setup()
    const { onSend } = setup()
    await record(user)

    expect(
      screen.queryByRole('textbox', { name: 'Ask anything' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('timer')).toHaveTextContent('00:00')
    expect(screen.getByTestId('level-ring')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('textbox', { name: 'Ask anything' })
    ).toBeInTheDocument()
    expect(micButton()).toBeInTheDocument()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('stop transcribes, then sends the text', async () => {
    const user = userEvent.setup()
    let finish!: (text: string) => void
    vi.mocked(transcribe).mockReturnValueOnce(
      new Promise(resolve => (finish = resolve))
    )
    const { onSend } = setup({ chatId: 'c1' })
    const stop = await record(user)
    speak()
    await user.click(stop)

    expect(await screen.findByRole('status')).toHaveTextContent('Transcribing…')
    expect(
      screen.getByRole('button', { name: 'Transcribing' })
    ).toHaveAttribute('aria-disabled', 'true')
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://ask.test.invalid',
        token: 'tok'
      })
    )

    await act(async () => finish('why is the sky blue'))
    expect(onSend).toHaveBeenCalledExactlyOnceWith('why is the sky blue', [])
    const input = screen.getByRole('textbox', { name: 'Ask anything' })
    expect(input).toHaveValue('')
    expect(micButton()).toBeInTheDocument()
    // One tap at the start and one at the stop; the send adds none.
    expect(vi.mocked(haptic).mock.calls).toEqual([['medium'], ['light']])
  })

  it('a stalled transcription can be cancelled: the box is back and nothing sends', async () => {
    const user = userEvent.setup()
    let finish!: (text: string) => void
    vi.mocked(transcribe).mockReturnValueOnce(
      new Promise(resolve => (finish = resolve))
    )
    const { onSend } = setup({ chatId: 'c1' })
    const stop = await record(user)
    speak()
    await user.click(stop)
    expect(await screen.findByRole('status')).toHaveTextContent('Transcribing…')

    await user.click(
      screen.getByRole('button', { name: 'Cancel transcription' })
    )
    const { signal } = vi.mocked(transcribe).mock.calls[0][0] as {
      signal: AbortSignal
    }
    expect(signal.aborted).toBe(true)
    expect(screen.getByRole('textbox', { name: 'Ask anything' })).toBeVisible()
    expect(micButton()).toBeInTheDocument()

    await act(async () => finish('too late'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('Attach is off from the moment the mic opens until the words are back', async () => {
    const user = userEvent.setup()
    const attach = () => screen.getByRole('button', { name: 'Attach' })
    let open!: (recording: Recording) => void
    vi.mocked(startRecording).mockReturnValueOnce(
      new Promise(resolve => (open = resolve))
    )
    let finish!: (text: string) => void
    vi.mocked(transcribe).mockReturnValueOnce(
      new Promise(resolve => (finish = resolve))
    )
    setup()
    expect(attach()).toBeEnabled()

    await user.click(micButton())
    expect(attach()).toBeDisabled()
    await act(async () => open(recording as Recording))
    expect(attach()).toBeDisabled()
    speak()
    await user.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Transcribing…')
    expect(attach()).toBeDisabled()

    await act(async () => finish(''))
    // "Didn't catch that": the mic is at rest again, and so is Attach.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(attach()).toBeEnabled()
  })

  it('shows the mic opening while the permission prompt is up', async () => {
    const user = userEvent.setup()
    let open!: (recording: Recording) => void
    vi.mocked(startRecording).mockReturnValueOnce(
      new Promise(resolve => (open = resolve))
    )
    setup()
    await user.click(micButton())
    expect(
      screen.getByRole('button', { name: 'Starting microphone' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('starting-ring')).toBeInTheDocument()

    await act(async () => open(recording as Recording))
    expect(
      screen.getByRole('button', { name: 'Stop recording' })
    ).toBeInTheDocument()
  })

  it('sends the text with files attached while recording', async () => {
    const user = userEvent.setup()
    const { onSend } = setup()
    const stop = await record(user)
    await user.upload(filePicker(), pdf())
    await waitFor(() => expect(uploadFile).toHaveBeenCalled())
    await act(async () => {})
    speak()
    await user.click(stop)

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledExactlyOnceWith('why is the sky blue', [
        expect.objectContaining({ filename: 'report.pdf' })
      ])
    )
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  it('puts the text in the box instead when it cannot be sent yet', async () => {
    const user = userEvent.setup()
    const { onSend } = setup({ disabled: true })
    const stop = await record(user)
    speak()
    await user.click(stop)

    const input = await screen.findByRole('textbox', { name: 'Ask anything' })
    await waitFor(() => expect(input).toHaveValue('why is the sky blue'))
    expect(onSend).not.toHaveBeenCalled()
    expect(sendButton()).toBeDisabled()
  })

  it("an empty transcript sends nothing and says it didn't catch that", async () => {
    const user = userEvent.setup()
    vi.mocked(transcribe).mockResolvedValueOnce('')
    const { onSend } = setup()
    const stop = await record(user)
    speak()
    await user.click(stop)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Didn't catch that"
    )
    expect(onSend).not.toHaveBeenCalled()
    expect(micButton()).toBeInTheDocument()
  })

  it('shows a refused microphone under the composer', async () => {
    const user = userEvent.setup()
    vi.mocked(startRecording).mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError')
    )
    setup()
    await user.click(micButton())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Allow microphone access in Settings to dictate'
    )
    expect(haptic).toHaveBeenCalledWith('error')
  })

  it('a running turn shows Stop, not the mic', () => {
    setup({ busy: true })
    expect(micQuery()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  describe('leaving mid-dictation', () => {
    beforeEach(() => {
      app.listeners.length = 0
    })

    function inTabs() {
      const onSend = vi.fn()
      render(
        <Tabs
          tabs={[
            {
              id: 'ask',
              label: 'Ask',
              icon: <svg />,
              render: () => (
                <Composer
                  placeholder="Ask anything"
                  busy={false}
                  onSend={onSend}
                  settings={BALANCED}
                  onSettings={vi.fn()}
                />
              )
            },
            {
              id: 'library',
              label: 'Library',
              icon: <svg />,
              render: () => <p>Your library</p>
            }
          ]}
        />
      )
      const tab = (name: string) => screen.getByRole('tab', { name })
      return { onSend, tab }
    }

    it('a tab switch mid-recording stops the mic and sends nothing', async () => {
      const user = userEvent.setup()
      const { onSend, tab } = inTabs()
      await record(user)
      await user.click(tab('Library'))

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      await user.click(tab('Ask'))
      expect(micButton()).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Ask anything' })).toHaveValue(
        ''
      )
      expect(transcribe).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('a tab switch mid-transcription drops the text', async () => {
      const user = userEvent.setup()
      let finish!: (text: string) => void
      vi.mocked(transcribe).mockReturnValueOnce(
        new Promise(resolve => (finish = resolve))
      )
      const { onSend, tab } = inTabs()
      const stop = await record(user)
      speak()
      await user.click(stop)
      await screen.findByText('Transcribing…')
      const { signal } = vi.mocked(transcribe).mock.calls[0][0] as {
        signal: AbortSignal
      }

      await user.click(tab('Library'))
      expect(signal.aborted).toBe(true)
      await act(async () => finish('why is the sky blue'))
      await user.click(tab('Ask'))

      expect(onSend).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'Ask anything' })).toHaveValue(
        ''
      )
      expect(micButton()).toBeInTheDocument()
    })

    it('a screen pushed over it mid-recording stops the mic', async () => {
      const user = userEvent.setup()
      const onSend = vi.fn()
      let stack!: ReturnType<typeof useStack>
      function Grab() {
        stack = useStack()
        return null
      }
      render(
        <StackProvider
          root={{
            key: 'home',
            render: () => (
              <Composer
                placeholder="Ask anything"
                busy={false}
                onSend={onSend}
                settings={BALANCED}
                onSettings={vi.fn()}
              />
            )
          }}
        >
          <Grab />
          <StackView />
        </StackProvider>
      )
      await record(user)
      act(() => stack.push({ key: 'thread', render: () => <p>Thread</p> }))

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('the app going to the background mid-recording stops the mic', async () => {
      const user = userEvent.setup()
      const { onSend } = setup()
      await record(user)
      await emitApp('appStateChange', { isActive: false })

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      expect(micButton()).toBeInTheDocument()
      expect(transcribe).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('text typed while the mic opens is kept: the words go after it, unsent', async () => {
      const user = userEvent.setup()
      let open!: (recording: Recording) => void
      vi.mocked(startRecording).mockReturnValueOnce(
        new Promise(resolve => (open = resolve))
      )
      const { onSend, input } = setup()
      await user.click(micButton())
      await user.type(input, 'hello ')
      await act(async () => open(recording as Recording))
      speak()
      await user.click(screen.getByRole('button', { name: 'Stop recording' }))

      const box = await screen.findByRole('textbox', { name: 'Ask anything' })
      await waitFor(() => expect(box).toHaveValue('hello why is the sky blue'))
      expect(onSend).not.toHaveBeenCalled()
      expect(sendButton()).toBeEnabled()
    })

    it('a deep link mid-recording cancels it and shows the link, unsent', async () => {
      const user = userEvent.setup()
      const { onSend, rerender } = setup()
      await record(user)
      rerender(
        <Composer
          placeholder="Ask anything"
          busy={false}
          onSend={onSend}
          settings={BALANCED}
          onSettings={vi.fn()}
          draft={{ text: 'From a link' }}
        />
      )

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      const input = screen.getByRole('textbox', { name: 'Ask anything' })
      expect(input).toHaveValue('From a link')
      expect(input).toHaveFocus()
      expect(transcribe).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('a deep link mid-transcription drops the words and shows the link alone', async () => {
      const user = userEvent.setup()
      let finish!: (text: string) => void
      vi.mocked(transcribe).mockReturnValueOnce(
        new Promise(resolve => (finish = resolve))
      )
      const { onSend, rerender } = setup()
      const stop = await record(user)
      speak()
      await user.click(stop)
      await screen.findByText('Transcribing…')
      rerender(
        <Composer
          placeholder="Ask anything"
          busy={false}
          onSend={onSend}
          settings={BALANCED}
          onSettings={vi.fn()}
          draft={{ text: 'From a link' }}
        />
      )
      await act(async () => finish('why is the sky blue'))

      const input = screen.getByRole('textbox', { name: 'Ask anything' })
      expect(input).toHaveValue('From a link')
      expect(onSend).not.toHaveBeenCalled()
    })
  })
})
